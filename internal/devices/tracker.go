package devices

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/store/db"
)

// Online tracking timings (spec, "Online tracker").
const (
	// OnlineWindow is how long a heartbeat keeps a device online.
	OnlineWindow = 45 * time.Second
	// FlushEvery is how often changed last_seen_at values are written out.
	FlushEvery = 30 * time.Second
	// ProbeEvery is how often hbbs is asked about devices that are not beating.
	ProbeEvery = 60 * time.Second
	// ProbeBatch is the most IDs sent to hbbs in one OnlineRequest.
	ProbeBatch = 1000
	// SweepEvery is how often Run reports devices whose online window lapsed.
	SweepEvery = 5 * time.Second
	// HBBSPresenceTTL is how long an hbbs report keeps a device online. It
	// outlasts one probe interval, so a device that stays online at hbbs is
	// re-marked before its presence lapses instead of flapping offline.
	HBBSPresenceTTL = ProbeEvery + OnlineWindow
	// entryRetention keeps recently offline connection data while dropping
	// idle entries well after their online signals have expired.
	entryRetention = 10 * HBBSPresenceTTL
)

// finalFlushTimeout bounds the flush Run does after its context ends.
const finalFlushTimeout = 5 * time.Second

// entry is what the tracker knows about one device.
type entry struct {
	beatAt time.Time // last heartbeat from the device itself
	conns  []int32   // connection ids from that heartbeat
	hbbsAt time.Time // last time hbbs reported the device online
}

// Tracker is the in-memory online state of a server's devices, keyed by
// rustdesk_id: when each last beat, its connection ids, and when hbbs last
// reported it. It is safe for concurrent use.
//
// A device is online while less than OnlineWindow has passed since its last
// heartbeat, or less than HBBSPresenceTTL since hbbs last reported it. Only heartbeats are written to the database
// (last_seen_at); an hbbs report extends the online window but is not a
// heartbeat and never dirties a device.
type Tracker struct {
	// Tick returns a channel delivering a value every d. Run uses it for its
	// flush and probe timers; tests replace it. It defaults to time.Tick and
	// must be set before Run starts.
	Tick func(d time.Duration) <-chan time.Time
	Log  *slog.Logger

	now func() time.Time

	// notifyMu serialises state changes that notify with their delivery, so
	// callbacks arrive in the order the transitions happened. Lock order is
	// notifyMu, then mu; the callback runs holding notifyMu but not mu, so it
	// may call tracker methods that take only mu, but not Beat, MarkOnline or
	// Sweep.
	notifyMu sync.Mutex

	mu      sync.Mutex
	entries map[string]entry
	dirty   map[string]time.Time // heartbeat times not yet flushed

	// reported holds the last online state passed to onChange, per device. A
	// device not in the map counts as offline.
	reported map[string]bool
	onChange func(rustdeskID string, online bool)
}

// NewTracker returns an empty Tracker that reads time from now.
func NewTracker(now func() time.Time) *Tracker {
	return &Tracker{
		Tick:     time.Tick,
		now:      now,
		entries:  map[string]entry{},
		dirty:    map[string]time.Time{},
		reported: map[string]bool{},
	}
}

// OnChange registers fn to be called when a device goes online (from Beat or
// MarkOnline) or offline (from Sweep). A second call replaces the first. fn is
// never called with the tracker's lock held. Register it before Run starts.
func (t *Tracker) OnChange(fn func(rustdeskID string, online bool)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.onChange = fn
}

// markReportedLocked records id as online and returns the callback to call,
// after the caller releases the lock, when that is a change. It returns nil
// otherwise.
func (t *Tracker) markReportedLocked(id string) func() {
	if t.reported[id] {
		return nil
	}
	t.reported[id] = true
	fn := t.onChange
	log := t.Log
	if fn == nil && log == nil {
		return nil
	}
	return func() {
		if log != nil {
			log.Info("device online", "rustdesk_id", id)
		}
		if fn != nil {
			fn(id, true)
		}
	}
}

// Sweep reports offline, once each, the devices that were reported online and
// are no longer online by the same rule as Online. Run calls it every
// SweepEvery.
func (t *Tracker) Sweep() {
	t.notifyMu.Lock()
	defer t.notifyMu.Unlock()
	now := t.now()
	t.mu.Lock()
	var lapsed []string
	for id, on := range t.reported {
		if on && !t.onlineLocked(id, now) {
			lapsed = append(lapsed, id)
		}
	}
	for _, id := range lapsed {
		delete(t.reported, id)
	}
	for id, e := range t.entries {
		last := e.beatAt
		if e.hbbsAt.After(last) {
			last = e.hbbsAt
		}
		if !last.IsZero() && now.Sub(last) >= entryRetention {
			if _, pendingFlush := t.dirty[id]; !pendingFlush {
				delete(t.entries, id)
				delete(t.reported, id)
			}
		}
	}
	fn := t.onChange
	log := t.Log
	t.mu.Unlock()

	if fn == nil && log == nil {
		return
	}
	slices.Sort(lapsed)
	for _, id := range lapsed {
		if log != nil {
			log.Info("device offline", "rustdesk_id", id)
		}
		if fn != nil {
			fn(id, false)
		}
	}
}

// Beat records a heartbeat from rustdeskID with its current connection ids.
// It satisfies Beater.
func (t *Tracker) Beat(rustdeskID string, conns []int32) {
	t.notifyMu.Lock()
	defer t.notifyMu.Unlock()
	at := t.now()
	t.mu.Lock()
	e := t.entries[rustdeskID]
	e.beatAt = at
	e.conns = slices.Clone(conns)
	t.entries[rustdeskID] = e
	t.dirty[rustdeskID] = at
	notify := t.markReportedLocked(rustdeskID)
	t.mu.Unlock()
	if notify != nil {
		notify()
	}
}

// Online reports whether rustdeskID beat within OnlineWindow or was reported
// by hbbs within HBBSPresenceTTL.
func (t *Tracker) Online(rustdeskID string) bool {
	now := t.now()
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.onlineLocked(rustdeskID, now)
}

func (t *Tracker) onlineLocked(id string, now time.Time) bool {
	e, ok := t.entries[id]
	if !ok {
		return false
	}
	return (!e.beatAt.IsZero() && now.Sub(e.beatAt) < OnlineWindow) ||
		(!e.hbbsAt.IsZero() && now.Sub(e.hbbsAt) < HBBSPresenceTTL)
}

// Conns returns a copy of the connection ids from rustdeskID's last
// heartbeat, or nothing if it never beat or reported none.
func (t *Tracker) Conns(rustdeskID string) []int32 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return slices.Clone(t.entries[rustdeskID].conns)
}

// MarkOnline records an hbbs-sourced presence for ids, keeping them online for
// HBBSPresenceTTL. It does not touch connection ids and is not flushed.
func (t *Tracker) MarkOnline(ids []string) {
	t.notifyMu.Lock()
	defer t.notifyMu.Unlock()
	at := t.now()
	var notify []func()
	t.mu.Lock()
	for _, id := range ids {
		e := t.entries[id]
		e.hbbsAt = at
		t.entries[id] = e
		if n := t.markReportedLocked(id); n != nil {
			notify = append(notify, n)
		}
	}
	t.mu.Unlock()
	for _, n := range notify {
		n()
	}
}

// Stale returns the ids that are not online, in the order given.
func (t *Tracker) Stale(ids []string) []string {
	now := t.now()
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []string
	for _, id := range ids {
		if !t.onlineLocked(id, now) {
			out = append(out, id)
		}
	}
	return out
}

// withoutHeartbeat returns the ids with no heartbeat within OnlineWindow, in
// the order given. Unlike Stale it ignores hbbs presence: the probe must keep
// asking hbbs about devices it already reported, or their presence would lapse
// between probes.
func (t *Tracker) withoutHeartbeat(ids []string) []string {
	now := t.now()
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []string
	for _, id := range ids {
		if e, ok := t.entries[id]; !ok || e.beatAt.IsZero() || now.Sub(e.beatAt) >= OnlineWindow {
			out = append(out, id)
		}
	}
	return out
}

// Flush writes the heartbeat times that changed since the last flush to
// devices.last_seen_at for serverID, in one statement, and returns how many
// tracker entries it attempted to write. That is not a row count: an entry
// whose device is unknown, rejected or archived matches no row (see
// UpdateLastSeen) but still counts, so the number depends only on the beats.
//
// Beats that arrive while the write runs are kept for the next flush. If the
// write fails, the batch is merged back (a newer beat wins) and the error is
// returned, so a later Flush retries it.
func (t *Tracker) Flush(ctx context.Context, pool *pgxpool.Pool, serverID uuid.UUID) (int, error) {
	t.mu.Lock()
	snapshot := t.dirty
	t.dirty = map[string]time.Time{}
	t.mu.Unlock()

	if len(snapshot) == 0 {
		return 0, nil
	}
	ids := make([]string, 0, len(snapshot))
	seen := make([]time.Time, 0, len(snapshot))
	for id, at := range snapshot {
		ids = append(ids, id)
		seen = append(seen, at.UTC())
	}
	err := db.New(pool).UpdateLastSeen(ctx, db.UpdateLastSeenParams{
		ServerID: serverID, RustdeskIds: ids, SeenAts: seen,
	})
	if err != nil {
		t.mu.Lock()
		for id, at := range snapshot {
			if cur, ok := t.dirty[id]; !ok || at.After(cur) {
				t.dirty[id] = at
			}
		}
		t.mu.Unlock()
		return 0, err
	}
	return len(snapshot), nil
}

// Run sweeps for offline devices every SweepEvery and flushes every FlushEvery
// until ctx ends, then flushes once more under a fresh 5 s context so the last
// beats survive shutdown. When query is not nil it also probes hbbs every
// ProbeEvery: approved lists the approved devices' rustdesk_ids, the ones with
// no heartbeat in OnlineWindow are sent to query in batches of ProbeBatch, and
// each id reported true is marked online. Errors from approved, query or a
// flush are logged and the cycle carries on; a failed batch is skipped. Run
// returns after ctx ends.
func (t *Tracker) Run(
	ctx context.Context, pool *pgxpool.Pool, serverID uuid.UUID,
	approved func(ctx context.Context) ([]string, error),
	query func(ctx context.Context, ids []string) (map[string]bool, error),
) {
	var probes sync.WaitGroup
	if query != nil && approved != nil {
		ticks := t.Tick(ProbeEvery)
		probes.Add(1)
		go func() {
			defer probes.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticks:
					t.probe(ctx, approved, query)
				}
			}
		}()
	}

	flushes := t.Tick(FlushEvery)
	sweeps := t.Tick(SweepEvery)
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case <-sweeps:
			t.Sweep()
		case <-flushes:
			if _, err := t.Flush(ctx, pool, serverID); err != nil && ctx.Err() == nil {
				slog.Error("online tracker: flush last_seen_at", "err", err)
			}
		}
	}

	probes.Wait()
	final, cancel := context.WithTimeout(context.Background(), finalFlushTimeout)
	defer cancel()
	if _, err := t.Flush(final, pool, serverID); err != nil {
		slog.Error("online tracker: final flush of last_seen_at", "err", err)
	}
}

// probe asks hbbs about approved devices with no recent heartbeat, in batches.
func (t *Tracker) probe(
	ctx context.Context,
	approved func(ctx context.Context) ([]string, error),
	query func(ctx context.Context, ids []string) (map[string]bool, error),
) {
	ids, err := approved(ctx)
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("online tracker: list approved devices for hbbs probe", "err", err)
		}
		return
	}
	stale := t.withoutHeartbeat(ids)
	for batch := range slices.Chunk(stale, ProbeBatch) {
		if ctx.Err() != nil {
			return
		}
		res, err := query(ctx, batch)
		if err != nil {
			if ctx.Err() == nil {
				slog.Error("online tracker: hbbs online query", "batch_size", len(batch), "err", err)
			}
			continue
		}
		var online []string
		for id, ok := range res {
			if ok {
				online = append(online, id)
			}
		}
		t.MarkOnline(online)
	}
}
