package stats_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/stats"
)

type snap struct {
	At                                  time.Time
	Approved, Online, Pending, Sessions int
}

func (e *env) snaps(t *testing.T) []snap {
	t.Helper()
	rows, err := e.pool.Query(context.Background(),
		`SELECT at, approved, online, pending, sessions FROM fleet_snapshots ORDER BY at`)
	require.NoError(t, err)
	defer rows.Close()
	var out []snap
	for rows.Next() {
		var s snap
		require.NoError(t, rows.Scan(&s.At, &s.Approved, &s.Online, &s.Pending, &s.Sessions))
		s.At = s.At.UTC()
		out = append(out, s)
	}
	require.NoError(t, rows.Err())
	return out
}

func TestSnapshotTakeAligned(t *testing.T) {
	e := newEnv(t)
	c := &clock{t: time.Date(2026, 10, 6, 10, 7, 30, 0, time.UTC)}
	s := &stats.Snapshotter{Pool: e.pool, Online: func(string) bool { return false }, Now: c.Now}

	require.NoError(t, s.Take(context.Background(), e.serverID))
	got := e.snaps(t)
	require.Len(t, got, 1)
	require.Equal(t, time.Date(2026, 10, 6, 10, 5, 0, 0, time.UTC), got[0].At)

	// The same slot again keeps the first snapshot.
	e.device(t, "100", "approved")
	c.Set(time.Date(2026, 10, 6, 10, 9, 59, 0, time.UTC))
	require.NoError(t, s.Take(context.Background(), e.serverID))
	got = e.snaps(t)
	require.Len(t, got, 1)
	require.Equal(t, 0, got[0].Approved)

	c.Set(time.Date(2026, 10, 6, 10, 10, 0, 0, time.UTC))
	require.NoError(t, s.Take(context.Background(), e.serverID))
	require.Len(t, e.snaps(t), 2)
}

func TestSnapshotCounts(t *testing.T) {
	e := newEnv(t)
	a1 := e.device(t, "101", "approved")
	e.device(t, "102", "approved")
	e.device(t, "103", "approved")
	e.device(t, "104", "pending")
	e.device(t, "105", "pending")
	e.device(t, "106", "rejected")
	archived := e.device(t, "107", "archived")
	now := time.Date(2026, 10, 6, 10, 7, 0, 0, time.UTC)

	e.openSession(t, a1, 1, now)
	e.openSession(t, a1, 2, now)
	e.openSession(t, archived, 3, now)   // not an approved device
	e.openUnauthedSession(t, a1, 4, now) // not authenticated
	_, err := e.pool.Exec(context.Background(),
		`INSERT INTO remote_sessions (device_id, conn_id, started_at, ended_at, end_reason, conn_seen_at)
		 VALUES ($1, 9, $2, $2, 'closed', $2)`, a1, now) // ended
	require.NoError(t, err)

	online := map[string]bool{"101": true, "102": true, "104": true} // 104 is pending
	s := &stats.Snapshotter{Pool: e.pool, Online: func(id string) bool { return online[id] }, Now: func() time.Time { return now }}
	require.NoError(t, s.Take(context.Background(), e.serverID))
	require.Equal(t, []snap{{At: now.Truncate(5 * time.Minute), Approved: 3, Online: 2, Pending: 2, Sessions: 2}}, e.snaps(t))
}

func TestSnapshotRunWaitsForWarmTracker(t *testing.T) {
	e := newEnv(t)
	start := time.Date(2026, 10, 6, 10, 7, 30, 0, time.UTC)
	c := &clock{t: start}
	tick := make(chan time.Time)
	started := make(chan struct{})
	s := &stats.Snapshotter{
		Pool: e.pool, Online: func(string) bool { return false }, Now: c.Now,
		Tick: func(time.Duration) <-chan time.Time { close(started); return tick }, // Run has read its start time
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx, e.serverID); close(done) }()
	<-started

	// step advances the clock, delivers a tick and waits until the loop has
	// handled it (it receives the next tick only after finishing this one).
	step := func(at time.Time) {
		c.Set(at)
		tick <- at
		tick <- at
	}
	step(start.Add(10 * time.Second))
	step(start.Add(44 * time.Second))
	require.Empty(t, e.snaps(t), "no snapshot while the tracker may still be cold")

	step(start.Add(45 * time.Second)) // warm: the current slot gets its row
	require.Len(t, e.snaps(t), 1)
	require.Equal(t, time.Date(2026, 10, 6, 10, 5, 0, 0, time.UTC), e.snaps(t)[0].At)

	step(time.Date(2026, 10, 6, 10, 9, 0, 0, time.UTC)) // same slot: nothing new
	require.Len(t, e.snaps(t), 1)
	step(time.Date(2026, 10, 6, 10, 10, 0, 0, time.UTC))
	require.Len(t, e.snaps(t), 2)

	cancel()
	<-done
}

func TestSnapshotRunClosesStaleSessions(t *testing.T) {
	e := newEnv(t)
	c := &clock{t: time.Date(2026, 10, 6, 10, 7, 30, 0, time.UTC)}
	tick := make(chan time.Time)
	calls := make(chan struct{}, 10)
	s := &stats.Snapshotter{
		Pool: e.pool, Online: func(string) bool { return false }, Now: c.Now,
		Tick:       func(time.Duration) <-chan time.Time { return tick },
		CloseStale: func(context.Context) (int64, error) { calls <- struct{}{}; return 0, nil },
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx, e.serverID); close(done) }()

	tick <- c.Now() // under a minute after the start: no sweep yet
	c.Set(c.Now().Add(61 * time.Second))
	tick <- c.Now()
	tick <- c.Now() // the previous tick is done
	require.Len(t, calls, 1)

	cancel()
	<-done
}
