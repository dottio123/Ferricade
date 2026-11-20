package stats_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/stats"
)

func TestHistoryDownsample(t *testing.T) {
	e := newEnv(t)
	hour := time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)
	// 12 snapshots: approved averages 10.5 and online 6.5, both rounding
	// up; sessions peak at 7.
	for i := 0; i < 12; i++ {
		sessions := 1
		if i == 4 {
			sessions = 7
		}
		pending := 1
		if i >= 9 {
			pending = 2 // mean 1.25 rounds to 1; the maximum would be 2
		}
		approved := 10
		if i >= 6 {
			approved = 11
		}
		e.snapshot(t, hour.Add(time.Duration(i)*5*time.Minute), approved, i+1, pending, sessions)
	}
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	res, err := stats.History(context.Background(), e.pool, "7d", now)
	require.NoError(t, err)
	require.Equal(t, "7d", res.Range)
	require.Equal(t, 3600, res.StepSeconds)
	require.Equal(t, []stats.Point{{At: hour, Approved: 11, Online: 7, Pending: 1, Sessions: 7}}, res.Points)
}

func TestHistoryOmitsEmptyBuckets(t *testing.T) {
	e := newEnv(t)
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	e.snapshot(t, now.Add(-23*time.Hour-55*time.Minute), 1, 1, 0, 0)
	e.snapshot(t, now.Add(-2*time.Hour), 2, 1, 0, 1)
	e.snapshot(t, now.Add(-24*time.Hour-5*time.Minute), 9, 9, 9, 9) // outside 24h
	res, err := stats.History(context.Background(), e.pool, "24h", now)
	require.NoError(t, err)
	require.Equal(t, 300, res.StepSeconds)
	require.Equal(t, []stats.Point{
		{At: now.Add(-23*time.Hour - 55*time.Minute), Approved: 1, Online: 1},
		{At: now.Add(-2 * time.Hour), Approved: 2, Online: 1, Sessions: 1},
	}, res.Points)

	res, err = stats.History(context.Background(), e.pool, "30d", now)
	require.NoError(t, err)
	require.Equal(t, 21600, res.StepSeconds)
	require.Len(t, res.Points, 3) // 30d buckets are 6 h wide, so the three snapshots stay apart
}

func TestHistoryEmptyAndInvalid(t *testing.T) {
	e := newEnv(t)
	res, err := stats.History(context.Background(), e.pool, "24h", time.Now())
	require.NoError(t, err)
	require.NotNil(t, res.Points)
	require.Empty(t, res.Points)
	_, err = stats.History(context.Background(), e.pool, "1y", time.Now())
	require.ErrorIs(t, err, stats.ErrInvalidRange)
}

func TestRetain(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	dev := e.device(t, "100", "approved")
	us := time.Microsecond

	snapCut, sessCut, nonceCut := now.Add(-90*24*time.Hour), now.Add(-365*24*time.Hour), now.Add(-7*24*time.Hour)
	e.snapshot(t, snapCut, 1, 1, 1, 1)
	e.snapshot(t, snapCut.Add(-us), 1, 1, 1, 1)
	for i, at := range []time.Time{sessCut, sessCut.Add(-us)} {
		_, err := e.pool.Exec(ctx, `INSERT INTO remote_sessions (device_id, conn_id, started_at, ended_at, end_reason, conn_seen_at)
			VALUES ($1, $2, $3, $3, 'closed', $3)`, dev, i+1, at)
		require.NoError(t, err)
	}
	// An open session is never retained away, however old.
	e.openSession(t, dev, 3, sessCut.Add(-time.Hour))
	for n, at := range map[string]time.Time{"keep": nonceCut, "drop": nonceCut.Add(-us)} {
		_, err := e.pool.Exec(ctx, `INSERT INTO seen_nonces (nonce, seen_at) VALUES ($1, $2)`, n, at)
		require.NoError(t, err)
	}

	require.NoError(t, stats.Retain(ctx, e.pool, now))

	var snaps, ended, open, nonces int
	var nonce string
	require.NoError(t, e.pool.QueryRow(ctx, `SELECT count(*) FROM fleet_snapshots WHERE at = $1`, snapCut).Scan(&snaps))
	require.Equal(t, 1, snaps)
	require.NoError(t, e.pool.QueryRow(ctx, `SELECT count(*) FROM fleet_snapshots`).Scan(&snaps))
	require.Equal(t, 1, snaps)
	require.NoError(t, e.pool.QueryRow(ctx, `SELECT count(*) FROM remote_sessions WHERE ended_at IS NOT NULL`).Scan(&ended))
	require.Equal(t, 1, ended)
	require.NoError(t, e.pool.QueryRow(ctx, `SELECT count(*) FROM remote_sessions WHERE ended_at IS NULL`).Scan(&open))
	require.Equal(t, 1, open)
	require.NoError(t, e.pool.QueryRow(ctx, `SELECT count(*), min(nonce) FROM seen_nonces`).Scan(&nonces, &nonce))
	require.Equal(t, 1, nonces)
	require.Equal(t, "keep", nonce)
}
