package servers

import (
	"context"
	"errors"
	"net"
	"syscall"
	"testing"

	"google.golang.org/protobuf/encoding/protowire"

	"github.com/dottio123/ferricade/internal/rendezvous"
)

func TestCheckReasonRefused(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	got := dialCheck(context.Background(), "id-server", addr, (&net.Dialer{}).DialContext)
	if got.OK || got.Reason != "refused" || got.Address != addr || got.Target != addr {
		t.Fatalf("check = %+v", got)
	}
}

func TestCheckReasonDNS(t *testing.T) {
	addr := "does-not-exist.invalid:21116"
	got := dialCheck(context.Background(), "id-server", addr, (&net.Dialer{}).DialContext)
	if got.OK || got.Reason != "dns" || got.Address != "" || got.Target != addr {
		t.Fatalf("check = %+v", got)
	}
}

func TestCheckReasonTimeout(t *testing.T) {
	got := dialCheck(context.Background(), "id-server", "host:21116", func(context.Context, string, string) (net.Conn, error) {
		return nil, context.DeadlineExceeded
	})
	if got.Reason != "timeout" || got.Address != "" {
		t.Fatalf("check = %+v", got)
	}
}

func TestCheckAddressOnSuccess(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	addr := ln.Addr().String()
	got := dialCheck(context.Background(), "id-server", addr, (&net.Dialer{}).DialContext)
	if !got.OK || got.Address != addr || got.Target != addr || got.Reason != "" {
		t.Fatalf("check = %+v", got)
	}
}

func TestCheckTargets(t *testing.T) {
	dial := func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("failed") }
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	hbbs := ln.Addr().String()
	ln.Close()
	got := Run(context.Background(), "id.example", "relay.example:1000", "client.example:21114", hbbs, dial)
	want := []string{"id.example:21116", "relay.example:1000", "client.example:21114", hbbs}
	if len(got) != len(want) {
		t.Fatalf("checks = %+v", got)
	}
	for i, target := range want {
		if got[i].Target != target {
			t.Errorf("check %d target = %q, want %q", i, got[i].Target, target)
		}
	}
}

func TestClassifyOther(t *testing.T) {
	if got := classify(errors.New("unknown")); got != "other" {
		t.Errorf("classify = %q", got)
	}
	if got := classify(syscall.EHOSTUNREACH); got != "unreachable" {
		t.Errorf("unreachable = %q", got)
	}
}

func TestRunChecks(t *testing.T) {
	var dialed []string
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialed = append(dialed, network+" "+addr)
		if addr == "relay.example.com:21117" {
			return nil, errors.New("connection refused")
		}
		c, _ := net.Pipe()
		return c, nil
	}
	got := Run(context.Background(), "rd.example.com", "relay.example.com", "rd.example.com:21114", "", dial)
	if len(got) != 3 {
		t.Fatalf("got %d checks, want 3: %+v", len(got), got)
	}
	if got[0].Name != "id-server" || !got[0].OK {
		t.Errorf("check 0 = %+v", got[0])
	}
	if got[1].Name != "relay" || got[1].OK || got[1].Detail != "connection refused" {
		t.Errorf("check 1 = %+v", got[1])
	}
	if got[2].Name != "client-api" || !got[2].OK {
		t.Errorf("check 2 = %+v", got[2])
	}
	want := []string{"tcp rd.example.com:21116", "tcp relay.example.com:21117", "tcp rd.example.com:21114"}
	if len(dialed) != 3 || dialed[0] != want[0] || dialed[1] != want[1] || dialed[2] != want[2] {
		t.Errorf("dialed %v; want %v", dialed, want)
	}
}

func TestRunOwnPorts(t *testing.T) {
	var dialed []string
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialed = append(dialed, addr)
		c, _ := net.Pipe()
		return c, nil
	}
	Run(context.Background(), "rd.example.com:1000", "[2001:db8::1]:2000", "x:21114", "", dial)
	if len(dialed) != 3 || dialed[0] != "rd.example.com:1000" || dialed[1] != "[2001:db8::1]:2000" || dialed[2] != "x:21114" {
		t.Errorf("dialed %v", dialed)
	}
	dialed = nil
	Run(context.Background(), "2001:db8::1", "relay", "[2001:db8::1]:21114", "", dial)
	if len(dialed) != 3 || dialed[0] != "[2001:db8::1]:21116" || dialed[1] != "relay:21117" || dialed[2] != "[2001:db8::1]:21114" {
		t.Errorf("dialed %v", dialed)
	}
}

func TestRunHbbsQuery(t *testing.T) {
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, _ := net.Pipe()
		return c, nil
	}
	// Nothing listens on this address, so the query fails and the detail carries the error.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	got := Run(context.Background(), "a", "b", "c:21114", addr, dial)
	if len(got) != 4 {
		t.Fatalf("got %d checks, want 4", len(got))
	}
	if got[2].Name != "client-api" || !got[2].OK {
		t.Errorf("check 2 = %+v", got[2])
	}
	if got[3].Name != "hbbs-online-query" || got[3].OK || got[3].Detail == "" {
		t.Errorf("check 3 = %+v", got[3])
	}
}

func TestRunHbbsQueryOK(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		if _, err := rendezvous.ReadFrame(c, 1<<20); err != nil {
			return
		}
		inner := protowire.AppendTag(nil, 1, protowire.BytesType)
		inner = protowire.AppendBytes(inner, []byte{0})
		msg := protowire.AppendTag(nil, 24, protowire.BytesType)
		_ = rendezvous.WriteFrame(c, protowire.AppendBytes(msg, inner))
	}()
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, _ := net.Pipe()
		return c, nil
	}
	got := Run(context.Background(), "a", "b", "c:21114", ln.Addr().String(), dial)
	if len(got) != 4 || got[3].Name != "hbbs-online-query" || !got[3].OK {
		t.Errorf("checks = %+v", got)
	}
}
