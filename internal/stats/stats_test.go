package stats_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

type env struct {
	pool     *pgxpool.Pool
	serverID uuid.UUID
}

func newEnv(t *testing.T) *env {
	t.Helper()
	pool := store.NewTestDB(t)
	srv, err := db.New(pool).CreateServer(context.Background(), db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	return &env{pool: pool, serverID: srv.ID}
}

func (e *env) device(t *testing.T, rustdeskID, state string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, e.pool.QueryRow(context.Background(),
		`INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, $2, $3, $4) RETURNING id`,
		e.serverID, rustdeskID, "u-"+rustdeskID, state).Scan(&id))
	return id
}

// openSession inserts an open, authenticated session of device on conn.
func (e *env) openSession(t *testing.T, device uuid.UUID, conn int, at time.Time) {
	t.Helper()
	_, err := e.pool.Exec(context.Background(),
		`INSERT INTO remote_sessions (device_id, conn_id, started_at, authed_at, conn_seen_at) VALUES ($1, $2, $3, $3, $3)`, device, conn, at)
	require.NoError(t, err)
}

// openUnauthedSession inserts an open session of device on conn whose peer
// has not authenticated: a connection attempt, which no count includes.
func (e *env) openUnauthedSession(t *testing.T, device uuid.UUID, conn int, at time.Time) {
	t.Helper()
	_, err := e.pool.Exec(context.Background(),
		`INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at) VALUES ($1, $2, $3, $3)`, device, conn, at)
	require.NoError(t, err)
}

func (e *env) snapshot(t *testing.T, at time.Time, approved, online, pending, sessions int) {
	t.Helper()
	_, err := e.pool.Exec(context.Background(),
		`INSERT INTO fleet_snapshots (at, approved, online, pending, sessions) VALUES ($1, $2, $3, $4, $5)`,
		at, approved, online, pending, sessions)
	require.NoError(t, err)
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time  { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Set(t time.Time) { c.mu.Lock(); defer c.mu.Unlock(); c.t = t }
