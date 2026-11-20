package sessions_test

import (
	"context"
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/contract"
	"github.com/dottio123/ferricade/internal/sessions"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

var t0 = time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)

const (
	devID   = "123456789"    // the fixtures' device
	devUUID = "ZmFrZS11dWlk" // and its uuid
)

var peerIP = netip.MustParseAddr("198.51.100.9")

type env struct {
	pool     *pgxpool.Pool
	svc      *sessions.Service
	serverID uuid.UUID
	deviceID uuid.UUID
	now      time.Time
}

// newEnv returns a sessions service on a fresh database holding the fixtures'
// device in the given state. The service's clock reads e.now.
func newEnv(t *testing.T, state string) *env {
	t.Helper()
	pool := store.NewTestDB(t)
	srv, err := db.New(pool).CreateServer(context.Background(), db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	e := &env{pool: pool, serverID: srv.ID, now: t0}
	e.svc = &sessions.Service{Pool: pool, Now: func() time.Time { return e.now }}
	e.deviceID = e.addDevice(t, devID, devUUID, state)
	return e
}

func (e *env) addDevice(t *testing.T, rustdeskID, devUUID, state string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, e.pool.QueryRow(context.Background(),
		`INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, $2, $3, $4) RETURNING id`,
		e.serverID, rustdeskID, devUUID, state).Scan(&id))
	return id
}

func (e *env) ingest(t *testing.T, a wire.ConnAudit) {
	t.Helper()
	require.NoError(t, e.svc.Ingest(context.Background(), e.serverID, a, peerIP))
}

// fixture loads testdata/contracts/derived-1.5.0/audit-conn-<name>.json.
func fixture(t *testing.T, name string) wire.ConnAudit {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "contracts", "derived-1.5.0", "audit-conn-"+name+".json"))
	require.NoError(t, err)
	var f contract.Fixture
	require.NoError(t, json.Unmarshal(b, &f))
	var a wire.ConnAudit
	require.NoError(t, json.Unmarshal(f.Body, &a))
	return a
}

// with returns a with another conn_id and nonce.
func with(a wire.ConnAudit, connID int32, nonce string) wire.ConnAudit {
	a.ConnID = connID
	a.Nonce = nonce
	return a
}

type sessionRow struct {
	ID          uuid.UUID
	DeviceID    uuid.UUID
	ConnID      int32
	RDSessionID *string
	PeerID      string
	PeerName    string
	Type        *int16
	ClientIP    *netip.Addr
	StartedAt   time.Time
	AuthedAt    *time.Time
	EndedAt     *time.Time
	EndReason   *string
	ConnSeenAt  time.Time
}

// rows returns every remote session, oldest first.
func rows(t *testing.T, pool *pgxpool.Pool) []sessionRow {
	t.Helper()
	rs, err := pool.Query(context.Background(), `
		SELECT id, device_id, conn_id, rd_session_id::text, peer_rustdesk_id, peer_name, type,
		       client_ip, started_at, authed_at, ended_at, end_reason, conn_seen_at
		FROM remote_sessions ORDER BY started_at, conn_id, id`)
	require.NoError(t, err)
	defer rs.Close()
	var out []sessionRow
	for rs.Next() {
		var r sessionRow
		require.NoError(t, rs.Scan(&r.ID, &r.DeviceID, &r.ConnID, &r.RDSessionID, &r.PeerID, &r.PeerName, &r.Type,
			&r.ClientIP, &r.StartedAt, &r.AuthedAt, &r.EndedAt, &r.EndReason, &r.ConnSeenAt))
		out = append(out, r)
	}
	require.NoError(t, rs.Err())
	return out
}

func count(t *testing.T, pool *pgxpool.Pool, table string) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT count(*) FROM `+table).Scan(&n))
	return n
}

func ptr[T any](v T) *T { return &v }

func TestIngestLifecycle(t *testing.T) {
	e := newEnv(t, "approved")
	e.ingest(t, fixture(t, "new"))
	e.now = t0.Add(5 * time.Second)
	e.ingest(t, fixture(t, "auth"))
	e.now = t0.Add(65 * time.Second)
	e.ingest(t, fixture(t, "close"))

	rs := rows(t, e.pool)
	require.Len(t, rs, 1)
	r := rs[0]
	assert.Equal(t, e.deviceID, r.DeviceID)
	assert.EqualValues(t, 3, r.ConnID)
	assert.Equal(t, "987654321", r.PeerID)
	assert.Equal(t, "bob", r.PeerName)
	assert.Equal(t, ptr(int16(0)), r.Type)
	assert.Equal(t, ptr(netip.MustParseAddr("203.0.113.7")), r.ClientIP)
	assert.Equal(t, ptr("12345678901234567891"), r.RDSessionID)
	assert.Equal(t, t0, r.StartedAt)
	assert.Equal(t, ptr(t0.Add(5*time.Second)), r.AuthedAt)
	assert.Equal(t, ptr(t0.Add(65*time.Second)), r.EndedAt)
	assert.Equal(t, ptr("closed"), r.EndReason)
	assert.Equal(t, 3, count(t, e.pool, "seen_nonces"))
}

func TestIngestOutOfOrderAndDuplicates(t *testing.T) {
	e := newEnv(t, "approved")

	// The same record twice has one effect.
	e.ingest(t, fixture(t, "new"))
	e.ingest(t, fixture(t, "new"))
	require.Len(t, rows(t, e.pool), 1)

	// A close with nothing open stores nothing.
	e.ingest(t, with(fixture(t, "close"), 7, "close-7"))
	require.Len(t, rows(t, e.pool), 1)

	// An auth with nothing open opens the session itself.
	e.now = t0.Add(10 * time.Second)
	auth8 := with(fixture(t, "auth"), 8, "auth-8")
	e.ingest(t, auth8)
	rs := rows(t, e.pool)
	require.Len(t, rs, 2)
	r := rs[1]
	assert.EqualValues(t, 8, r.ConnID)
	assert.Equal(t, e.now, r.StartedAt)
	assert.Equal(t, e.now, r.ConnSeenAt)
	assert.Equal(t, ptr(e.now), r.AuthedAt)
	assert.Nil(t, r.ClientIP)
	assert.Equal(t, "987654321", r.PeerID)
	assert.Nil(t, r.EndedAt)

	e.now = t0.Add(20 * time.Second)
	e.ingest(t, with(fixture(t, "close"), 8, "close-8"))
	// A replayed auth after the close does not reopen it.
	e.now = t0.Add(30 * time.Second)
	e.ingest(t, auth8)
	rs = rows(t, e.pool)
	require.Len(t, rs, 2)
	assert.Equal(t, ptr(t0.Add(20*time.Second)), rs[1].EndedAt)
	assert.Equal(t, ptr("closed"), rs[1].EndReason)
	assert.Nil(t, rs[0].EndedAt, "conn 3 is untouched")
}

// An auth record that overtakes its "new" opens the session; the late "new"
// fills in its client_ip instead of replacing it.
func TestIngestAuthBeforeNewMerges(t *testing.T) {
	e := newEnv(t, "approved")
	e.ingest(t, fixture(t, "auth"))
	e.now = t0.Add(2 * time.Second)
	e.ingest(t, fixture(t, "new"))

	rs := rows(t, e.pool)
	require.Len(t, rs, 1)
	r := rs[0]
	assert.Nil(t, r.EndedAt)
	assert.Equal(t, "987654321", r.PeerID)
	assert.Equal(t, "bob", r.PeerName)
	assert.Equal(t, ptr(netip.MustParseAddr("203.0.113.7")), r.ClientIP)
	assert.Equal(t, t0, r.StartedAt, "the earlier start is kept")
	assert.Equal(t, ptr(t0), r.AuthedAt)
	assert.Equal(t, t0.Add(2*time.Second), r.ConnSeenAt)
	assert.Equal(t, ptr("12345678901234567891"), r.RDSessionID, "new's session_id 0 does not erase it")

	e.now = t0.Add(30 * time.Second)
	e.ingest(t, fixture(t, "close"))
	rs = rows(t, e.pool)
	require.Len(t, rs, 1)
	assert.Equal(t, ptr(t0.Add(30*time.Second)), rs[0].EndedAt)
	assert.Equal(t, ptr("closed"), rs[0].EndReason)
}

func TestIngestConnIDReuse(t *testing.T) {
	e := newEnv(t, "approved")
	e.ingest(t, fixture(t, "new"))
	e.now = t0.Add(10 * time.Second)
	e.ingest(t, with(fixture(t, "new"), 3, "new-again"))

	rs := rows(t, e.pool)
	require.Len(t, rs, 2)
	assert.Equal(t, ptr(rs[0].ConnSeenAt), rs[0].EndedAt)
	assert.Equal(t, ptr(t0), rs[0].EndedAt)
	assert.Equal(t, ptr("stale"), rs[0].EndReason)
	assert.Equal(t, t0.Add(10*time.Second), rs[1].StartedAt)
	assert.Nil(t, rs[1].EndedAt)
}

func TestIngestRejectsUnknownOrMismatched(t *testing.T) {
	for _, tc := range []struct {
		name, state, id, uuid string
	}{
		{"unknown id", "approved", "999999999", devUUID},
		{"wrong uuid", "approved", devID, "b3RoZXI="},
		{"pending device", "pending", devID, devUUID},
		{"rejected", "rejected", devID, devUUID},
		{"archived", "archived", devID, devUUID},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t, tc.state)
			for _, name := range []string{"new", "auth", "close"} {
				a := fixture(t, name)
				a.ID, a.UUID = tc.id, tc.uuid
				e.ingest(t, a)
			}
			assert.Zero(t, count(t, e.pool, "remote_sessions"))
			assert.Zero(t, count(t, e.pool, "seen_nonces"))
			assert.Zero(t, count(t, e.pool, "device_alerts"), "a mismatch is not flagged here")
			assert.Equal(t, 1, count(t, e.pool, "devices"), "nothing enrolled")
		})
	}
}

func TestIngestLargeSessionID(t *testing.T) {
	e := newEnv(t, "approved")
	e.ingest(t, fixture(t, "new"))
	rs := rows(t, e.pool)
	require.Len(t, rs, 1)
	assert.Nil(t, rs[0].RDSessionID, "session_id 0 is stored as null")

	a := fixture(t, "auth")
	a.SessionID = 18446744073709551615
	e.ingest(t, a)
	rs = rows(t, e.pool)
	require.Len(t, rs, 1)
	assert.Equal(t, ptr("18446744073709551615"), rs[0].RDSessionID)
}

// Hostile or odd peer arrays: a missing name is empty, long values are cut
// to 128 characters, an out-of-range type is unknown, a bad ip is null.
func TestIngestNormalisesClientFields(t *testing.T) {
	e := newEnv(t, "approved")
	n := fixture(t, "new")
	n.IP = "not-an-ip"
	e.ingest(t, n)
	a := fixture(t, "auth")
	a.Peer = []string{"987654321"}
	a.Type = ptr(70000)
	e.ingest(t, a)
	r := rows(t, e.pool)[0]
	assert.Nil(t, r.ClientIP)
	assert.Equal(t, "987654321", r.PeerID)
	assert.Equal(t, "", r.PeerName)
	assert.Nil(t, r.Type)

	long := strings.Repeat("é", 200)
	a = with(fixture(t, "auth"), 4, "auth-4")
	a.Peer = []string{long, long, "extra"}
	e.ingest(t, a)
	r = rows(t, e.pool)[1]
	assert.Equal(t, strings.Repeat("é", 128), r.PeerID)
	assert.Equal(t, strings.Repeat("é", 128), r.PeerName)

	// An empty peer array is no auth record; nothing changes.
	a = with(fixture(t, "auth"), 5, "auth-5")
	a.Peer = nil
	e.ingest(t, a)
	assert.Len(t, rows(t, e.pool), 2)

	// An IPv4-mapped address is stored as IPv4.
	n = with(fixture(t, "new"), 6, "new-6")
	n.IP = "::ffff:203.0.113.8"
	e.ingest(t, n)
	assert.Equal(t, ptr(netip.MustParseAddr("203.0.113.8")), rows(t, e.pool)[2].ClientIP)
}

func TestSyncConnsClosesStale(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, "approved")
	other := e.addDevice(t, "222222222", "b3RoZXI=", "approved")
	e.ingest(t, fixture(t, "new")) // conn 3 at t0
	o := with(fixture(t, "new"), 3, "other-3")
	o.ID, o.UUID = "222222222", "b3RoZXI="
	e.ingest(t, o)

	e.now = t0.Add(59 * time.Second)
	syncOK(t)(e.svc.SyncConns(ctx, e.serverID, devID, devUUID, []int32{}))
	require.Nil(t, rows(t, e.pool)[0].EndedAt, "59 s missing is not stale")

	// A wrong uuid is ignored.
	e.now = t0.Add(61 * time.Second)
	syncOK(t)(e.svc.SyncConns(ctx, e.serverID, devID, "b3RoZXI=", nil))
	require.Nil(t, rows(t, e.pool)[0].EndedAt)

	syncOK(t)(e.svc.SyncConns(ctx, e.serverID, devID, devUUID, nil))
	rs := rows(t, e.pool)
	byDevice := map[uuid.UUID]sessionRow{rs[0].DeviceID: rs[0], rs[1].DeviceID: rs[1]}
	assert.Equal(t, ptr(t0), byDevice[e.deviceID].EndedAt)
	assert.Equal(t, ptr("stale"), byDevice[e.deviceID].EndReason)
	assert.Nil(t, byDevice[other].EndedAt, "another device's session is untouched")

	// A conn the heartbeat reports stays fresh.
	e.now = t0.Add(100 * time.Second)
	e.ingest(t, with(fixture(t, "new"), 4, "new-4"))
	e.now = t0.Add(150 * time.Second)
	syncOK(t)(e.svc.SyncConns(ctx, e.serverID, devID, devUUID, []int32{4, 9}))
	e.now = t0.Add(200 * time.Second)
	syncOK(t)(e.svc.SyncConns(ctx, e.serverID, devID, devUUID, []int32{}))
	r := rows(t, e.pool)[2]
	require.EqualValues(t, 4, r.ConnID)
	assert.Equal(t, t0.Add(150*time.Second), r.ConnSeenAt)
	assert.Nil(t, r.EndedAt)
	e.now = t0.Add(211 * time.Second)
	syncOK(t)(e.svc.SyncConns(ctx, e.serverID, devID, devUUID, []int32{}))
	r = rows(t, e.pool)[2]
	assert.Equal(t, ptr(t0.Add(150*time.Second)), r.EndedAt)
	assert.Equal(t, ptr("stale"), r.EndReason)
}

func TestSessionNotifyOnCommitOnly(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	e := newEnv(t, "approved")
	listener, err := e.pool.Acquire(ctx)
	require.NoError(t, err)
	defer listener.Release()
	_, err = listener.Exec(ctx, "LISTEN ferricade_events")
	require.NoError(t, err)

	tx, err := e.pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at)
		VALUES ($1, 99, now(), now())`, e.deviceID)
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))

	e.ingest(t, fixture(t, "new"))
	id := rows(t, e.pool)[0].ID

	type event struct {
		Kind      string    `json:"kind"`
		Op        string    `json:"op"`
		SessionID uuid.UUID `json:"session_id"`
		DeviceID  uuid.UUID `json:"device_id"`
	}
	next := func() event {
		t.Helper()
		n, err := listener.Conn().WaitForNotification(ctx)
		require.NoError(t, err)
		assert.Equal(t, "ferricade_events", n.Channel)
		var ev event
		require.NoError(t, json.Unmarshal([]byte(n.Payload), &ev), n.Payload)
		return ev
	}
	// The rolled-back insert would have been delivered first.
	assert.Equal(t, event{"session", "started", id, e.deviceID}, next())

	e.ingest(t, fixture(t, "auth")) // the authentication is announced (migration 00006)
	assert.Equal(t, event{"session", "updated", id, e.deviceID}, next())
	e.ingest(t, with(fixture(t, "auth"), 3, "auth-again")) // a later auth record is silent
	e.ingest(t, fixture(t, "close"))
	assert.Equal(t, event{"session", "ended", id, e.deviceID}, next())
}

func TestCloseStale(t *testing.T) {
	e := newEnv(t, "approved")
	ctx := context.Background()
	other := e.addDevice(t, "987654321", "other-uuid", "approved")
	ins := func(dev uuid.UUID, conn int, seen time.Time, ended bool) {
		q := `INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at) VALUES ($1, $2, $3, $3)`
		if ended {
			q = `INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at, ended_at, end_reason) VALUES ($1, $2, $3, $3, $3, 'closed')`
		}
		_, err := e.pool.Exec(ctx, q, dev, conn, seen)
		require.NoError(t, err)
	}
	stale, fresh, closed := e.now.Add(-61*time.Second), e.now.Add(-59*time.Second), e.now.Add(-time.Hour)
	ins(e.deviceID, 1, stale, false)
	ins(other, 2, fresh, false)
	ins(other, 3, closed, true)

	n, err := e.svc.CloseStale(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 1, n)

	type row struct {
		ended  *time.Time
		reason *string
	}
	get := func(conn int) row {
		var r row
		require.NoError(t, e.pool.QueryRow(ctx, `SELECT ended_at, end_reason FROM remote_sessions WHERE conn_id = $1`, conn).Scan(&r.ended, &r.reason))
		return r
	}
	r := get(1)
	require.NotNil(t, r.ended)
	require.True(t, stale.Equal(*r.ended))
	require.Equal(t, "stale", *r.reason)
	require.Nil(t, get(2).ended)
	require.Equal(t, "closed", *get(3).reason)
}

// A later auth record on the same open session (a second authentication
// step, or a sparse record) fills gaps but never erases what an earlier one
// stored: no null type, no blank peer id or name.
func TestIngestLaterAuthKeepsDetails(t *testing.T) {
	e := newEnv(t, "approved")
	e.ingest(t, fixture(t, "new"))
	e.ingest(t, fixture(t, "auth")) // peer 987654321 "bob", type 0

	sparse := with(fixture(t, "auth"), 3, "auth-sparse")
	sparse.Peer = []string{""}
	sparse.Type = nil
	e.ingest(t, sparse)
	r := rows(t, e.pool)[0]
	assert.Equal(t, "987654321", r.PeerID)
	assert.Equal(t, "bob", r.PeerName)
	assert.Equal(t, ptr(int16(0)), r.Type)

	// A later record that does carry values still updates them.
	richer := with(fixture(t, "auth"), 3, "auth-richer")
	richer.Peer = []string{"111", "carol"}
	richer.Type = ptr(1)
	e.ingest(t, richer)
	r = rows(t, e.pool)[0]
	assert.Equal(t, "111", r.PeerID)
	assert.Equal(t, "carol", r.PeerName)
	assert.Equal(t, ptr(int16(1)), r.Type)
}

// syncOK takes SyncConns' two results and requires that it did not fail.
func syncOK(t *testing.T) func([]int32, error) {
	return func(_ []int32, err error) {
		t.Helper()
		require.NoError(t, err)
	}
}
