package logexport

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

var facilityCodes = map[string]int{
	"kern": 0, "user": 1, "mail": 2, "daemon": 3, "auth": 4, "syslog": 5,
	"lpr": 6, "news": 7, "uucp": 8, "cron": 9, "authpriv": 10, "ftp": 11,
	"local0": 16, "local1": 17, "local2": 18, "local3": 19,
	"local4": 20, "local5": 21, "local6": 22, "local7": 23,
}

var ErrSyslogReplaced = errors.New("syslog output replaced")

type SyslogOutput struct {
	Host     string
	Port     int
	TLS      bool
	CAPEM    string
	Facility string
	Format   string
	Hostname string

	mu     sync.Mutex
	conn   net.Conn
	closed bool
	dial   func(context.Context, string, string) (net.Conn, error)
}

func (*SyslogOutput) Name() string { return "syslog" }

func (s *SyslogOutput) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return s.closeLocked()
}

func (s *SyslogOutput) closeLocked() error {
	if s.conn == nil {
		return nil
	}
	err := s.conn.Close()
	s.conn = nil
	return err
}

func (s *SyslogOutput) Deliver(ctx context.Context, recs []Record) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.Host == "" {
		return errors.New("no syslog host set")
	}
	var batch bytes.Buffer
	for _, rec := range recs {
		msg, err := s.message(rec)
		if err != nil {
			return err
		}
		batch.WriteString(strconv.Itoa(len(msg)))
		batch.WriteByte(' ')
		batch.Write(msg)
	}
	if batch.Len() == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrSyslogReplaced
	}
	if s.conn != nil && !s.openLocked() {
		_ = s.closeLocked()
	}
	if s.conn == nil {
		conn, err := s.connect(ctx)
		if err != nil {
			return err
		}
		s.conn = conn
	}
	deadline := time.Now().Add(10 * time.Second)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := s.conn.SetWriteDeadline(deadline); err != nil {
		_ = s.closeLocked()
		return fmt.Errorf("syslog write deadline: %w", err)
	}
	remaining := batch.Bytes()
	for len(remaining) > 0 {
		n, err := s.conn.Write(remaining)
		if err != nil {
			_ = s.closeLocked()
			return fmt.Errorf("syslog write: %w", err)
		}
		if n == 0 {
			_ = s.closeLocked()
			return io.ErrShortWrite
		}
		remaining = remaining[n:]
	}
	return nil
}

func (s *SyslogOutput) openLocked() bool {
	if err := s.conn.SetReadDeadline(time.Now().Add(time.Millisecond)); err != nil {
		return false
	}
	var b [1]byte
	n, err := s.conn.Read(b[:])
	_ = s.conn.SetReadDeadline(time.Time{})
	if n != 0 || err == nil {
		return false
	}
	var timeout net.Error
	return errors.As(err, &timeout) && timeout.Timeout()
}

func (s *SyslogOutput) connect(ctx context.Context) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	address := net.JoinHostPort(s.Host, strconv.Itoa(s.Port))
	dial := s.dial
	if dial == nil {
		dial = (&net.Dialer{}).DialContext
	}
	conn, err := dial(ctx, "tcp", address)
	if err != nil {
		return nil, fmt.Errorf("syslog dial: %w", err)
	}
	if !s.TLS {
		return conn, nil
	}
	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		roots = x509.NewCertPool()
	}
	if s.CAPEM != "" && !roots.AppendCertsFromPEM([]byte(s.CAPEM)) {
		_ = conn.Close()
		return nil, errors.New("syslog CA PEM has no certificates")
	}
	tlsConn := tls.Client(conn, &tls.Config{MinVersion: tls.VersionTLS12, ServerName: s.Host, RootCAs: roots})
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = tlsConn.Close()
		return nil, fmt.Errorf("syslog TLS handshake: %w", err)
	}
	return tlsConn, nil
}

func (s *SyslogOutput) message(rec Record) ([]byte, error) {
	facility, ok := facilityCodes[s.Facility]
	if !ok {
		return nil, fmt.Errorf("invalid syslog facility %q", s.Facility)
	}
	severity := 5
	if rec.Event.Outcome == "failure" {
		severity = 4
	}
	hostname := rec.Observer.Hostname
	if hostname == "" {
		hostname = "-"
	}
	msgID := []rune(rec.Event.Action)
	if len(msgID) > 32 {
		msgID = msgID[:32]
	}
	var body []byte
	switch s.Format {
	case "json":
		var err error
		body, err = json.Marshal(rec)
		if err != nil {
			return nil, fmt.Errorf("marshal syslog record: %w", err)
		}
	case "text":
		var b strings.Builder
		appendText := func(key, value string) {
			if value == "" {
				return
			}
			if b.Len() > 0 {
				b.WriteByte(' ')
			}
			b.WriteString(key)
			b.WriteByte('=')
			b.WriteString(escapeTextValue(value, false))
		}
		appendText("action", rec.Event.Action)
		appendText("outcome", rec.Event.Outcome)
		appendText("user", rec.User.Name)
		if rec.Source != nil {
			appendText("source_ip", rec.Source.IP)
		}
		if rec.Ferricade.Target != nil {
			target := rec.Ferricade.Target.Name
			if target == "" {
				target = rec.Ferricade.Target.ID
			}
			appendText("target", target)
		}
		if rec.Ferricade.Device != nil {
			appendText("device", rec.Ferricade.Device.RustdeskID)
		}
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString("msg=")
		b.WriteString(escapeTextValue(rec.Message, true))
		body = []byte(b.String())
	default:
		return nil, fmt.Errorf("invalid syslog format %q", s.Format)
	}
	header := fmt.Sprintf("<%d>1 %s %s ferricade - %s - ", facility*8+severity, rec.Timestamp, hostname, string(msgID))
	return append([]byte(header), body...), nil
}

func escapeTextValue(value string, alwaysQuote bool) string {
	var b strings.Builder
	quoted := alwaysQuote
	for _, r := range value {
		switch r {
		case '\\':
			b.WriteString(`\\`)
			quoted = true
		case '"':
			b.WriteString(`\"`)
			quoted = true
		case '\r':
			b.WriteString(`\r`)
			quoted = true
		case '\n':
			b.WriteString(`\n`)
			quoted = true
		case '\t':
			b.WriteString(`\t`)
			quoted = true
		default:
			if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
				fmt.Fprintf(&b, `\u%04X`, r)
				quoted = true
			} else {
				b.WriteRune(r)
				if r == ' ' || r == '=' {
					quoted = true
				}
			}
		}
	}
	if quoted {
		return `"` + b.String() + `"`
	}
	return b.String()
}
