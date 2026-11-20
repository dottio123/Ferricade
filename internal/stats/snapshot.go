// Package stats keeps the fleet's trend history: a snapshot of device and
// session counts every five minutes, the downsampled history the web UI
// charts, and the retention of old rows.
package stats

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store/db"
)

// SnapshotEvery is the snapshot interval; snapshots are aligned to it.
const SnapshotEvery = 5 * time.Minute

const (
	pollEvery       = 10 * time.Second // how often Run looks at the clock
	staleSweepEvery = time.Minute
	retainEvery     = time.Hour
	taskTimeout     = 30 * time.Second
)

// Snapshotter records the fleet snapshots and runs the periodic upkeep.
type Snapshotter struct {
	Pool *pgxpool.Pool
	// Online reports whether an approved device is online, as the tracker does.
	Online func(rustdeskID string) bool
	Now    func() time.Time // defaults to time.Now
	// CloseStale, when set, runs every minute: it ends the open sessions of
	// devices that stopped reporting (sessions.Service.CloseStale).
	CloseStale func(ctx context.Context) (int64, error)
	// Tick returns a channel delivering a value every d. Run polls the clock
	// with it; tests replace it. It defaults to time.Tick.
	Tick func(d time.Duration) <-chan time.Time
	Log  *slog.Logger
}

func (s *Snapshotter) now() time.Time {
	if s.Now == nil {
		return time.Now().UTC()
	}
	return s.Now().UTC()
}

// Take records a snapshot of the server's fleet in the current five-minute
// slot. A slot that already has one keeps it.
func (s *Snapshotter) Take(ctx context.Context, serverID uuid.UUID) error {
	q := db.New(s.Pool)
	ids, err := q.ListApprovedRustdeskIDs(ctx, serverID)
	if err != nil {
		return fmt.Errorf("stats: list approved devices: %w", err)
	}
	online := 0
	for _, id := range ids {
		if s.Online(id) {
			online++
		}
	}
	pending, err := q.CountPendingDevices(ctx, serverID)
	if err != nil {
		return fmt.Errorf("stats: count pending devices: %w", err)
	}
	open, err := q.CountOpenSessionsOfApproved(ctx, serverID)
	if err != nil {
		return fmt.Errorf("stats: count open sessions: %w", err)
	}
	if err := q.InsertFleetSnapshot(ctx, db.InsertFleetSnapshotParams{
		At: s.now().Truncate(SnapshotEvery), Approved: int32(len(ids)), Online: int32(online),
		Pending: int32(pending), Sessions: open,
	}); err != nil {
		return fmt.Errorf("stats: insert snapshot: %w", err)
	}
	return nil
}

// Run takes its first snapshot once the tracker is warm (devices.OnlineWindow
// after the start), then at each five-minute boundary; it closes
// stale sessions every minute and prunes old rows every hour, until ctx ends.
func (s *Snapshotter) Run(ctx context.Context, serverID uuid.UUID) {
	log := s.Log
	if log == nil {
		log = slog.Default()
	}
	tick := s.Tick
	if tick == nil {
		tick = time.Tick
	}
	task := func(name string, fn func(ctx context.Context) error) {
		ctx, cancel := context.WithTimeout(ctx, taskTimeout)
		defer cancel()
		started := time.Now()
		if err := fn(ctx); err != nil {
			if ctx.Err() == nil {
				log.Error("stats: "+name, "err", err)
			}
			return
		}
		log.Debug("stats: "+name, "duration_ms", time.Since(started).Milliseconds())
	}
	take := func() { task("snapshot", func(ctx context.Context) error { return s.Take(ctx, serverID) }) }
	retain := func() { task("retention", func(ctx context.Context) error { return Retain(ctx, s.Pool, s.now()) }) }
	sweep := func() {
		if s.CloseStale == nil {
			return
		}
		task("close stale sessions", func(ctx context.Context) error { _, err := s.CloseStale(ctx); return err })
	}

	// Tracker.Online reads in-memory heartbeats only, so right after a start
	// every device looks offline. No snapshot is taken until the tracker has
	// had a full online window to hear from them; the first one then goes to
	// the current slot, and a slot's row is never rewritten.
	start := s.now()
	warm := start.Add(devices.OnlineWindow)
	var lastSlot time.Time
	lastSweep, lastRetain := start, start
	retain()

	polls := tick(pollEvery)
	for {
		select {
		case <-ctx.Done():
			return
		case <-polls:
		}
		now := s.now()
		if slot := now.Truncate(SnapshotEvery); !now.Before(warm) && slot.After(lastSlot) {
			lastSlot = slot
			take()
		}
		if now.Sub(lastSweep) >= staleSweepEvery {
			lastSweep = now
			sweep()
		}
		if now.Sub(lastRetain) >= retainEvery {
			lastRetain = now
			retain()
		}
	}
}
