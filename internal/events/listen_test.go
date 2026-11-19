package events_test

import (
	"bytes"
	"context"
	"log/slog"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/events"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// syncBuffer is a log destination safe for the listener's goroutine.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// startListen runs Listen on pool until the test ends, and returns the
// backend PID of its connection once it is listening.
func startListen(t *testing.T, pool *pgxpool.Pool, hub *events.Hub, logs *syncBuffer) int32 {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		events.Listen(ctx, pool, hub, slog.New(slog.NewJSONHandler(logs, nil)))
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("Listen did not return after its context ended")
		}
	})
	return waitListening(t, pool, 0)
}

// waitListening waits until a connection other than notPID has run LISTEN on
// the test database, and returns its backend PID.
func waitListening(t *testing.T, pool *pgxpool.Pool, notPID int32) int32 {
	t.Helper()
	var pid int32
	require.Eventually(t, func() bool {
		err := pool.QueryRow(context.Background(),
			`SELECT pid FROM pg_stat_activity
			 WHERE datname = current_database() AND pid <> pg_backend_pid() AND pid <> $1
			   AND query = 'LISTEN ferricade_events' AND state = 'idle'`, notPID).Scan(&pid)
		return err == nil
	}, 5*time.Second, 20*time.Millisecond, "the listener never ran LISTEN")
	return pid
}

// recvN returns the next n events on ch.
func recvN(t *testing.T, ch <-chan events.Event, n int) []events.Event {
	t.Helper()
	out := make([]events.Event, 0, n)
	for range n {
		out = append(out, recv(t, ch))
	}
	return out
}

func recordAudit(t *testing.T, pool *pgxpool.Pool, action, targetType, targetID string) string {
	t.Helper()
	ctx := context.Background()
	require.NoError(t, audit.Record(ctx, db.New(pool), audit.Event{
		ActorIP: netip.MustParseAddr("127.0.0.1"), Action: action, TargetType: targetType, TargetID: targetID,
	}))
	var id uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT id FROM audit_events WHERE action = $1 ORDER BY at DESC LIMIT 1`, action).Scan(&id))
	return id.String()
}

func TestListenMapsGroupRulesAudit(t *testing.T) {
	pool := store.NewTestDB(t)
	hub := events.NewHub()
	ch, stop := hub.Subscribe("admin")
	defer stop()
	startListen(t, pool, hub, &syncBuffer{})
	for _, action := range []string{"group.rule_added", "group.rule_removed", "group.deleted"} {
		recordAudit(t, pool, action, "group", uuid.NewString())
		require.Equal(t, events.TypeAuditCreated, recv(t, ch).Type)
		require.Equal(t, events.Event{Type: "group_rules.updated"}, recv(t, ch))
	}
}

func TestListenMapsIDAllowListAudit(t *testing.T) {
	pool := store.NewTestDB(t)
	hub := events.NewHub()
	ch, stop := hub.Subscribe("admin")
	defer stop()
	startListen(t, pool, hub, &syncBuffer{})
	auditID := recordAudit(t, pool, "id_allow_list.updated", "id_allow_list", uuid.NewString())
	require.Equal(t, events.Event{Type: events.TypeAuditCreated, AuditID: auditID, TargetType: "id_allow_list"}, recv(t, ch))
	require.Equal(t, events.Event{Type: "id_allow_list.updated"}, recv(t, ch))
}

func TestListenMapsAuditAndSession(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	srv, err := db.New(pool).CreateServer(ctx, db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	var deviceID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO devices (server_id, rustdesk_id, uuid) VALUES ($1, '123', 'u') RETURNING id`, srv.ID).Scan(&deviceID))
	var userID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (username, role, password_hash) VALUES ('alice', 'admin', 'x') RETURNING id`).Scan(&userID))
	dev := deviceID.String()

	hub := events.NewHub()
	ch, unsub := hub.Subscribe(userID.String())
	t.Cleanup(unsub)
	startListen(t, pool, hub, &syncBuffer{})

	approved := recordAudit(t, pool, "device.approved", "device", dev)
	assert.Equal(t, []events.Event{
		{Type: events.TypeAuditCreated, AuditID: approved, TargetType: "device"},
		{Type: events.TypeDeviceUpdated, DeviceID: dev},
	}, recvN(t, ch, 2))

	enrolled := recordAudit(t, pool, "device.enrolled", "device", dev)
	assert.Equal(t, []events.Event{
		{Type: events.TypeAuditCreated, AuditID: enrolled, TargetType: "device"},
		{Type: events.TypeDeviceUpdated, DeviceID: dev},
		{Type: events.TypeDeviceEnrolled, DeviceID: dev},
	}, recvN(t, ch, 3))

	// A deleted device is announced as deleted only: a device.updated would
	// send clients to refetch a device that is gone.
	deleted := recordAudit(t, pool, "device.deleted", "device", dev)
	assert.Equal(t, []events.Event{
		{Type: events.TypeAuditCreated, AuditID: deleted, TargetType: "device"},
		{Type: events.TypeDeviceDeleted, DeviceID: dev},
	}, recvN(t, ch, 2))

	other := recordAudit(t, pool, "user.created", "user", userID.String())
	assert.Equal(t, events.Event{Type: events.TypeAuditCreated, AuditID: other, TargetType: "user"}, recv(t, ch),
		"an audit event about something else is only audit.created")

	var sessionID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at) VALUES ($1, 1, now(), now()) RETURNING id`,
		deviceID).Scan(&sessionID))
	assert.Equal(t, events.Event{Type: events.TypeSessionStarted, SessionID: sessionID.String(), DeviceID: dev}, recv(t, ch))

	// Only the authentication of an open session is announced as an update,
	// and only once: other changes, and a later auth record, are not.
	_, err = pool.Exec(ctx, `UPDATE remote_sessions SET conn_seen_at = now() WHERE id = $1`, sessionID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE remote_sessions SET authed_at = now(), peer_rustdesk_id = '555' WHERE id = $1`, sessionID)
	require.NoError(t, err)
	assert.Equal(t, events.Event{Type: events.TypeSessionUpdated, SessionID: sessionID.String(), DeviceID: dev}, recv(t, ch))
	_, err = pool.Exec(ctx, `UPDATE remote_sessions SET authed_at = now() WHERE id = $1`, sessionID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `UPDATE remote_sessions SET ended_at = now(), end_reason = 'closed' WHERE id = $1`, sessionID)
	require.NoError(t, err)
	assert.Equal(t, events.Event{Type: events.TypeSessionEnded, SessionID: sessionID.String(), DeviceID: dev}, recv(t, ch),
		"no second session.updated came before the end")

	// A change to what sysinfo reports is a device update; heartbeat times,
	// other columns and a value written unchanged are not.
	for _, col := range []string{"hostname", "os", "client_version", "username"} {
		_, err = pool.Exec(ctx, `UPDATE devices SET last_seen_at = now(), cpu = cpu || 'x', hostname = hostname, os = os,
			client_version = client_version, username = username WHERE id = $1`, deviceID)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE devices SET `+col+` = `+col+` || 'x' WHERE id = $1`, deviceID)
		require.NoError(t, err)
		assert.Equal(t, events.Event{Type: events.TypeDeviceUpdated, DeviceID: dev}, recv(t, ch), col)
	}

	_, err = pool.Exec(ctx, `INSERT INTO user_preferences (user_id, prefs, updated_at) VALUES ($1, '{}', now())`, userID)
	require.NoError(t, err)
	assert.Equal(t, events.Event{Type: events.TypePreferencesUpdated, UserID: userID.String()}, recv(t, ch))
}

func TestListenReconnects(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	hub := events.NewHub()
	ch, unsub := hub.Subscribe("")
	t.Cleanup(unsub)
	var logs syncBuffer
	pid := startListen(t, pool, hub, &logs)

	var killed bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT pg_terminate_backend($1)`, pid).Scan(&killed))
	require.True(t, killed)

	// Notifications sent while it was disconnected are lost, so once it is
	// listening again every subscriber is closed and must refetch.
	select {
	case e, ok := <-ch:
		require.False(t, ok, "unexpected event before the resync: %+v", e)
	case <-time.After(5 * time.Second):
		t.Fatal("the subscriber was not closed within 5 s of the connection being terminated")
	}
	assert.NotEqual(t, pid, waitListening(t, pool, pid), "a new connection is listening")

	// Events flow again to a new subscriber.
	ch2, unsub2 := hub.Subscribe("")
	t.Cleanup(unsub2)
	ping := recordAudit(t, pool, "test.ping", "", "")
	assert.Equal(t, events.Event{Type: events.TypeAuditCreated, AuditID: ping}, recv(t, ch2))

	var warned bool
	for line := range strings.Lines(logs.String()) {
		if strings.Contains(line, `"level":"WARN"`) && strings.Contains(line, "reconnect") {
			warned = true
		}
	}
	assert.True(t, warned, "the reconnect is logged at WARN: %s", logs.String())
}
