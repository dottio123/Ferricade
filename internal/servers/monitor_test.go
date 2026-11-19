package servers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestMonitorRecord(t *testing.T) {
	var logs bytes.Buffer
	m := &Monitor{Log: slog.New(slog.NewTextHandler(&logs, nil))}
	first := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	got := m.Latest()
	require.Equal(t, "unknown", got.Status)
	require.Nil(t, got.CheckedAt)
	require.Empty(t, got.Checks)
	m.Record([]Check{{Name: "id-server", OK: false, Detail: "dial failed", Target: "id.example:21116", Address: "203.0.113.10:21116", Reason: "refused"}, {Name: "relay", OK: true, Target: "relay.example:21117", Address: "203.0.113.10:21117"}}, first)
	got = m.Latest()
	require.Equal(t, "id.example:21116", got.Checks[0].Target)
	require.Equal(t, "203.0.113.10:21116", got.Checks[0].Address)
	require.Equal(t, "refused", *got.Checks[0].Reason)
	body, err := json.Marshal(got.Checks[1])
	require.NoError(t, err)
	require.Contains(t, string(body), `"reason":null`)
	require.Equal(t, "degraded", got.Status)
	require.Equal(t, first, *got.CheckedAt)
	require.Equal(t, first, got.Checks[0].Since)
	require.Equal(t, first, got.Checks[1].Since)
	require.Equal(t, 1, strings.Count(logs.String(), "rustdesk server check failed"))
	require.Contains(t, logs.String(), "id.example:21116")
	require.Contains(t, logs.String(), "203.0.113.10:21116")
	m.Record([]Check{{Name: "id-server", OK: false, Detail: "still down"}, {Name: "relay", OK: true}}, first.Add(time.Minute))
	require.Equal(t, first, m.Latest().Checks[0].Since)
	require.Equal(t, 1, strings.Count(logs.String(), "rustdesk server check failed"))
	require.Contains(t, logs.String(), "id.example:21116")
	require.Contains(t, logs.String(), "203.0.113.10:21116")
	m.Record([]Check{{Name: "id-server", OK: true}, {Name: "relay", OK: true}}, first.Add(2*time.Minute))
	got = m.Latest()
	require.Equal(t, "ok", got.Status)
	require.Equal(t, first.Add(2*time.Minute), got.Checks[0].Since)
	require.Equal(t, first, got.Checks[1].Since)
	require.Equal(t, 1, strings.Count(logs.String(), "rustdesk server check recovered"))
	got.Checks[0].Detail = "changed"
	require.Empty(t, m.Latest().Checks[0].Detail)
	*got.CheckedAt = first
	require.Equal(t, first.Add(2*time.Minute), *m.Latest().CheckedAt)
}

func TestMonitorRunSkipsSetupAndStops(t *testing.T) {
	var logs bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	m := &Monitor{Log: slog.New(slog.NewTextHandler(&logs, nil)), Interval: 10 * time.Millisecond,
		Dial: func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("dial failed") }}
	loads := make(chan struct{}, 10)
	done := make(chan struct{})
	go func() {
		m.Run(ctx, func(context.Context) (string, string, string, bool, error) {
			select {
			case loads <- struct{}{}:
			default:
			}
			return "", "", "", false, nil
		})
		close(done)
	}()
	select {
	case <-loads:
	case <-time.After(time.Second):
		t.Fatal("initial load did not run")
	}
	require.Equal(t, "unknown", m.Latest().Status)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("monitor did not stop")
	}
	require.Empty(t, logs.String())
}

func TestMonitorRunDialsClientAPIAddress(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dialed := make(chan string, 3)
	m := &Monitor{Dial: func(_ context.Context, network, addr string) (net.Conn, error) {
		dialed <- network + " " + addr
		c, _ := net.Pipe()
		return c, nil
	}}
	done := make(chan struct{})
	go func() {
		m.Run(ctx, func(context.Context) (string, string, string, bool, error) {
			return "rd.example.com", "relay.example.com", "https://api.example.com:8443", true, nil
		})
		close(done)
	}()
	got := make([]string, 0, 3)
	deadline := time.After(time.Second)
	for len(got) < 3 {
		select {
		case addr := <-dialed:
			got = append(got, addr)
		case <-deadline:
			t.Fatal("monitor did not run all dial checks")
		}
	}
	require.Equal(t, []string{"tcp rd.example.com:21116", "tcp relay.example.com:21117", "tcp api.example.com:8443"}, got)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("monitor did not stop")
	}
}
