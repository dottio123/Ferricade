// Package servers probes the RustDesk server ports and the hbbs online query.
package servers

import (
	"context"
	"errors"
	"net"
	"syscall"
	"time"

	"github.com/dottio123/ferricade/internal/rendezvous"
)

const stepTimeout = 3 * time.Second

// Check is the outcome of one server probe.
type Check struct {
	Name    string
	OK      bool
	Detail  string
	Target  string
	Address string
	Reason  string
}

// Run dials the ID server (default port 21116), relay (default 21117), and
// client API address, then, when hbbsAddr is non-empty, runs a rendezvous
// online query. Each step has a 3 s timeout. A failed check's Detail is the
// underlying error text.
func Run(ctx context.Context, idHost, relayHost, clientAPIAddr, hbbsAddr string,
	dial func(ctx context.Context, network, addr string) (net.Conn, error)) []Check {
	checks := []Check{
		dialCheck(ctx, "id-server", withPort(idHost, "21116"), dial),
		dialCheck(ctx, "relay", withPort(relayHost, "21117"), dial),
		dialCheck(ctx, "client-api", clientAPIAddr, dial),
	}
	if hbbsAddr != "" {
		checks = append(checks, queryCheck(ctx, hbbsAddr))
	}
	return checks
}

// withPort returns host:port, keeping a port the host already carries.
func withPort(host, defPort string) string {
	if _, _, err := net.SplitHostPort(host); err == nil {
		return host
	}
	if len(host) > 1 && host[0] == '[' && host[len(host)-1] == ']' {
		host = host[1 : len(host)-1]
	}
	return net.JoinHostPort(host, defPort)
}

func dialCheck(ctx context.Context, name, addr string,
	dial func(ctx context.Context, network, addr string) (net.Conn, error)) Check {
	ctx, cancel := context.WithTimeout(ctx, stepTimeout)
	defer cancel()
	conn, err := dial(ctx, "tcp", addr)
	if err != nil {
		return Check{Name: name, Detail: err.Error(), Target: addr, Address: failedAddr(err), Reason: classify(err)}
	}
	address := ""
	if remote := conn.RemoteAddr(); remote != nil {
		address = remote.String()
	}
	conn.Close()
	return Check{Name: name, OK: true, Target: addr, Address: address}
}

func queryCheck(ctx context.Context, addr string) Check {
	ctx, cancel := context.WithTimeout(ctx, stepTimeout)
	defer cancel()
	if _, err := rendezvous.QueryOnline(ctx, addr, []string{"ferricade-probe"}); err != nil {
		return Check{Name: "hbbs-online-query", Detail: err.Error(), Target: addr, Address: failedAddr(err), Reason: classify(err)}
	}
	return Check{Name: "hbbs-online-query", OK: true, Target: addr}
}

func classify(err error) string {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns"
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return "refused"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() || errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETUNREACH) {
		return "unreachable"
	}
	return "other"
}

func failedAddr(err error) string {
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Addr != nil {
		return opErr.Addr.String()
	}
	return ""
}
