package logexport

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func testRecord(id string) Record {
	return Record{Timestamp: "2026-10-21T14:03:12.481Z", Event: EventFields{ID: id, Action: "device.approved", Outcome: "success"}, Message: "Approved device", User: UserFields{Name: "José Doe"}, Observer: ObserverFields{Hostname: "ferricade.example.com"}, Ferricade: FerricadeFields{Details: json.RawMessage(`{}`)}}
}

func readSyslog(t *testing.T, r *bufio.Reader) string {
	t.Helper()
	lengthText, err := r.ReadString(' ')
	require.NoError(t, err)
	length, err := strconv.Atoi(strings.TrimSpace(lengthText))
	require.NoError(t, err)
	msg := make([]byte, length)
	_, err = io.ReadFull(r, msg)
	require.NoError(t, err)
	require.Equal(t, length, len(msg))
	return string(msg)
}

func TestSyslogFramingAndBodies(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	got := make(chan string, 2)
	go func() {
		_ = ln.(*net.TCPListener).SetDeadline(time.Now().Add(5 * time.Second))
		c, e := ln.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		r := bufio.NewReader(c)
		for i := 0; i < 2; i++ {
			got <- readSyslog(t, r)
		}
	}()
	out := &SyslogOutput{Host: "127.0.0.1", Port: port, Facility: "local0", Format: "json"}
	defer out.Close()
	rec := testRecord("one")
	require.NoError(t, out.Deliver(context.Background(), []Record{rec}))
	jsonMsg := awaitSyslog(t, got)
	require.True(t, strings.HasPrefix(jsonMsg, "<133>1 2026-10-21T14:03:12.481Z ferricade.example.com ferricade - device.approved - "), jsonMsg)
	body := jsonMsg[strings.LastIndex(jsonMsg, " - ")+3:]
	want, err := json.Marshal(rec)
	require.NoError(t, err)
	require.Equal(t, string(want), body)
	rec.Event.Action = "abcdefghijklmnopqrstuvwxyz123456789"
	rec.Event.Outcome = "failure"
	rec.Observer.Hostname = ""
	rec.Message = "A sentence"
	rec.User.Name = `José Doe "X"=\\`
	rec.Source = &SourceFields{IP: "203.0.113.5"}
	rec.Ferricade.Target = &TargetFields{ID: "fallback", Name: "Lab PC"}
	rec.Ferricade.Device = &DeviceFields{RustdeskID: "123 456"}
	out.Format = "text"
	out.Facility = "auth"
	require.NoError(t, out.Deliver(context.Background(), []Record{rec}))
	textMsg := awaitSyslog(t, got)
	require.True(t, strings.HasPrefix(textMsg, "<36>1 2026-10-21T14:03:12.481Z - ferricade - abcdefghijklmnopqrstuvwxyz123456 - "), textMsg)
	require.Contains(t, textMsg, `action=abcdefghijklmnopqrstuvwxyz123456789 outcome=failure user="José Doe \"X\"=\\\\" source_ip=203.0.113.5 target="Lab PC" device="123 456" msg="A sentence"`)
	require.NotContains(t, textMsg, "\n")
}

func TestSyslogTextOmitsEmptyAndUsesTargetID(t *testing.T) {
	rec := testRecord("one")
	rec.User.Name = ""
	rec.Ferricade.Target = &TargetFields{ID: "fallback"}
	out := &SyslogOutput{Facility: "local0", Format: "text"}
	msg, err := out.message(rec)
	require.NoError(t, err)
	require.Contains(t, string(msg), `action=device.approved outcome=success target=fallback msg="Approved device"`)
	for _, key := range []string{"user=", "source_ip=", "device="} {
		require.NotContains(t, string(msg), key)
	}
}

func TestSyslogTextEscapesInjection(t *testing.T) {
	rec := testRecord("one")
	rec.Event.Action = "auth.login_failed"
	rec.Event.Outcome = "failure"
	rec.User.Name = "x action=auth.login outcome=success\n<14>1 x"
	rec.Message = "Sign-in failed for " + rec.User.Name + "\r\t\u2028\u2029\x01"
	out := &SyslogOutput{Facility: "auth", Format: "text"}
	msg, err := out.message(rec)
	require.NoError(t, err)
	text := string(msg)
	require.Equal(t, 0, strings.Count(text, "\n"))
	require.Equal(t, 0, strings.Count(text, "\r"))
	require.Contains(t, text, ` - action=auth.login_failed outcome=failure user="x action=auth.login outcome=success\n<14>1 x" msg="Sign-in failed for x action=auth.login outcome=success\n<14>1 x\r\t\u2028\u2029\u0001"`)
}

func TestSyslogClosedOutputNeverDials(t *testing.T) {
	out := &SyslogOutput{Host: "127.0.0.1", Port: 6514, Facility: "local0", Format: "json"}
	out.dial = func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("replaced output dialed again")
		return nil, nil
	}
	require.NoError(t, out.Close())
	require.ErrorContains(t, out.Deliver(context.Background(), []Record{testRecord("one")}), "syslog output replaced")
}

func testTLSCert(t *testing.T) (tls.Certificate, string) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "private test CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	require.NoError(t, err)
	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	server := &x509.Certificate{SerialNumber: big.NewInt(2), DNSNames: []string{"collector.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	serverDER, err := x509.CreateCertificate(rand.Reader, server, ca, &serverKey.PublicKey, caKey)
	require.NoError(t, err)
	return tls.Certificate{Certificate: [][]byte{serverDER, caDER}, PrivateKey: serverKey}, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}))
}

func TestSyslogTLSHostMismatchRefused(t *testing.T) {
	cert, ca := testTLSCert(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	received := make(chan []byte, 1)
	go func() {
		_ = ln.(*net.TCPListener).SetDeadline(time.Now().Add(5 * time.Second))
		c, e := ln.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		tlsConn := tls.Server(c, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
		_ = tlsConn.Handshake()
		b := make([]byte, 1024)
		n, _ := tlsConn.Read(b)
		received <- b[:n]
	}()
	out := &SyslogOutput{Host: "127.0.0.1", Port: port, TLS: true, CAPEM: ca, Facility: "local0", Format: "json"}
	err = out.Deliver(context.Background(), []Record{testRecord("one")})
	require.ErrorContains(t, err, "certificate")
	require.Empty(t, awaitSyslog(t, received), "no event bytes may be sent after failed verification")

	for _, tc := range []struct {
		name, ca string
		max      uint16
		wantErr  string
	}{
		{"private CA", ca, tls.VersionTLS13, ""},
		{"unknown authority", "", tls.VersionTLS13, "certificate"},
		{"TLS 1.1", ca, tls.VersionTLS11, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			listener, e := net.Listen("tcp", "127.0.0.1:0")
			require.NoError(t, e)
			defer listener.Close()
			result := make(chan string, 1)
			go func() {
				_ = listener.(*net.TCPListener).SetDeadline(time.Now().Add(5 * time.Second))
				c, e := listener.Accept()
				if e != nil {
					return
				}
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(5 * time.Second))
				tc := tls.Server(c, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tc.max, MaxVersion: tc.max})
				if e = tc.Handshake(); e != nil {
					result <- ""
					return
				}
				result <- readSyslog(t, bufio.NewReader(tc))
			}()
			o := &SyslogOutput{Host: "collector.test", Port: listener.Addr().(*net.TCPAddr).Port, TLS: true, CAPEM: tc.ca, Facility: "local0", Format: "json"}
			// A dial override keeps the production ServerName while reaching the in-test listener.
			o.dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "tcp", listener.Addr().String())
			}
			defer o.Close()
			e = o.Deliver(context.Background(), []Record{testRecord("one")})
			if tc.name == "private CA" {
				require.NoError(t, e)
				require.Contains(t, awaitSyslog(t, result), "ferricade")
			} else {
				require.Error(t, e)
				require.Empty(t, awaitSyslog(t, result))
			}
		})
	}
}
