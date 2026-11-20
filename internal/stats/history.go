package stats

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/store/db"
)

// Retention windows.
const (
	SnapshotRetention = 90 * 24 * time.Hour
	SessionRetention  = 365 * 24 * time.Hour // after a session ends
	NonceRetention    = 7 * 24 * time.Hour
)

// ErrInvalidRange is returned by History for a range other than 24h, 7d or 30d.
var ErrInvalidRange = errors.New("stats: invalid range")

// Point is one history bucket: the rounded mean device counts of its
// snapshots and the peak of their open sessions.
type Point struct {
	At       time.Time
	Approved int
	Online   int
	Pending  int
	Sessions int
}

// HistoryResult is a range of fleet history, oldest bucket first.
type HistoryResult struct {
	Range       string
	StepSeconds int
	Points      []Point // never nil
}

var ranges = map[string]struct{ window, step time.Duration }{
	"24h": {24 * time.Hour, 5 * time.Minute},
	"7d":  {7 * 24 * time.Hour, time.Hour},
	"30d": {30 * 24 * time.Hour, 6 * time.Hour},
}

// History returns the snapshots of the last rng ("24h", "7d" or "30d", else
// ErrInvalidRange) grouped into buckets of the range's step. Buckets without
// a snapshot are left out.
func History(ctx context.Context, pool *pgxpool.Pool, rng string, now time.Time) (HistoryResult, error) {
	r, ok := ranges[rng]
	if !ok {
		return HistoryResult{}, ErrInvalidRange
	}
	rows, err := db.New(pool).FleetHistory(ctx, db.FleetHistoryParams{
		StepSeconds: int32(r.step / time.Second), RangeStart: now.Add(-r.window),
	})
	if err != nil {
		return HistoryResult{}, fmt.Errorf("stats: history: %w", err)
	}
	res := HistoryResult{Range: rng, StepSeconds: int(r.step / time.Second), Points: make([]Point, len(rows))}
	for i, row := range rows {
		res.Points[i] = Point{
			At: row.Bucket.UTC(), Approved: int(row.Approved), Online: int(row.Online),
			Pending: int(row.Pending), Sessions: int(row.Sessions),
		}
	}
	return res, nil
}

// Retain deletes snapshots older than 90 days, sessions that ended more than
// 365 days ago and nonces older than 7 days. Open sessions are kept.
func Retain(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
	q := db.New(pool)
	if _, err := q.DeleteOldFleetSnapshots(ctx, now.Add(-SnapshotRetention)); err != nil {
		return fmt.Errorf("stats: prune snapshots: %w", err)
	}
	cut := now.Add(-SessionRetention)
	if _, err := q.DeleteOldRemoteSessions(ctx, &cut); err != nil {
		return fmt.Errorf("stats: prune sessions: %w", err)
	}
	if _, err := q.DeleteOldSeenNonces(ctx, now.Add(-NonceRetention)); err != nil {
		return fmt.Errorf("stats: prune nonces: %w", err)
	}
	return nil
}
