package devices_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/devices"
)

// fakeClock is a settable clock safe for use from Run's goroutines.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = t
}

func newTracker() (*devices.Tracker, *fakeClock) {
	c := &fakeClock{t: t0}
	return devices.NewTracker(c.now), c
}

func TestTrackerOnlineWindow(t *testing.T) {
	tr, clock := newTracker()
	require.False(t, tr.Online("a"))

	tr.Beat("a", nil)
	require.True(t, tr.Online("a"))
	clock.set(t0.Add(44 * time.Second))
	require.True(t, tr.Online("a"))
	clock.set(t0.Add(45 * time.Second))
	require.False(t, tr.Online("a"))
}

func TestTrackerConns(t *testing.T) {
	tr, _ := newTracker()
	require.Empty(t, tr.Conns("a"))

	conns := []int32{1, 2}
	tr.Beat("a", conns)
	require.Equal(t, []int32{1, 2}, tr.Conns("a"))

	// The tracker keeps its own copy, in both directions.
	conns[0] = 99
	require.Equal(t, []int32{1, 2}, tr.Conns("a"))
	tr.Conns("a")[0] = 99
	require.Equal(t, []int32{1, 2}, tr.Conns("a"))

	tr.Beat("a", nil)
	require.Empty(t, tr.Conns("a"))
}

func TestTrackerMarkOnline(t *testing.T) {
	tr, clock := newTracker()
	tr.MarkOnline([]string{"x"})
	require.True(t, tr.Online("x"))
	require.Equal(t, []string{"y"}, tr.Stale([]string{"x", "y"}))

	// hbbs presence outlasts the 60 s probe interval, so it cannot flap.
	require.Equal(t, 105*time.Second, devices.HBBSPresenceTTL)
	clock.set(t0.Add(60 * time.Second))
	require.True(t, tr.Online("x"))
	clock.set(t0.Add(104 * time.Second))
	require.True(t, tr.Online("x"))
	clock.set(t0.Add(105 * time.Second))
	require.False(t, tr.Online("x"))
	require.Equal(t, []string{"x", "y"}, tr.Stale([]string{"x", "y"}))

	// A re-mark (the next probe) renews it.
	tr.MarkOnline([]string{"x"})
	clock.set(t0.Add(209 * time.Second))
	require.True(t, tr.Online("x"))
}

func TestTrackerMarkOnlineDoesNotShortenBeat(t *testing.T) {
	tr, clock := newTracker()
	tr.Beat("a", []int32{7})
	clock.set(t0.Add(30 * time.Second))
	tr.MarkOnline([]string{"a"})
	// hbbs presence extends the window but keeps the heartbeat's conns.
	clock.set(t0.Add(70 * time.Second)) // heartbeat alone lapsed at +45s
	require.True(t, tr.Online("a"))
	require.Equal(t, []int32{7}, tr.Conns("a"))
}

func TestTrackerStalePreservesOrder(t *testing.T) {
	tr, _ := newTracker()
	tr.Beat("b", nil)
	require.Equal(t, []string{"z", "a", "c"}, tr.Stale([]string{"z", "b", "a", "c"}))
	require.Empty(t, tr.Stale(nil))
}

func (f *fixture) enroll(t *testing.T, ids ...string) {
	t.Helper()
	for _, id := range ids {
		f.heartbeat(t, id, uuidA)
	}
}

func TestTrackerFlushWritesChanged(t *testing.T) {
	f := newFixture(t, 500)
	f.enroll(t, "a", "b")
	ctx := context.Background()

	tr, clock := newTracker()
	tr.Beat("a", nil)
	tr.Beat("b", nil)
	n, err := tr.Flush(ctx, f.pool, f.serverID)
	require.NoError(t, err)
	require.Equal(t, 2, n)
	require.True(t, t0.Equal(f.device(t, "a").LastSeenAt))
	require.True(t, t0.Equal(f.device(t, "b").LastSeenAt))

	clock.set(t0.Add(10 * time.Second))
	tr.Beat("a", nil)
	n, err = tr.Flush(ctx, f.pool, f.serverID)
	require.NoError(t, err)
	require.Equal(t, 1, n)
	require.True(t, t0.Add(10*time.Second).Equal(f.device(t, "a").LastSeenAt))
	require.True(t, t0.Equal(f.device(t, "b").LastSeenAt))

	n, err = tr.Flush(ctx, f.pool, f.serverID)
	require.NoError(t, err)
	require.Equal(t, 0, n)
}

func TestTrackerFlushCountsAttemptedEntries(t *testing.T) {
	f := newFixture(t, 500)
	f.enroll(t, "a")

	tr, _ := newTracker()
	tr.Beat("a", nil)
	tr.Beat("unknown", nil) // no devices row: attempted, matches nothing
	n, err := tr.Flush(context.Background(), f.pool, f.serverID)
	require.NoError(t, err)
	require.Equal(t, 2, n)
}

func TestTrackerFlushSkipsRejectedAndArchived(t *testing.T) {
	f := newFixture(t, 500)
	f.enroll(t, "a", "b", "c")
	f.setState(t, "a", "rejected")
	f.setState(t, "b", "archived")
	f.setState(t, "c", "approved")
	before := f.device(t, "a").LastSeenAt

	tr, _ := newTracker()
	for _, id := range []string{"a", "b", "c"} {
		tr.Beat(id, nil)
	}
	_, err := tr.Flush(context.Background(), f.pool, f.serverID)
	require.NoError(t, err)

	require.True(t, before.Equal(f.device(t, "a").LastSeenAt), "rejected device must not be touched")
	require.False(t, t0.Equal(f.device(t, "b").LastSeenAt), "archived device must not be touched")
	require.True(t, t0.Equal(f.device(t, "c").LastSeenAt))
}

func TestTrackerFlushFailureKeepsBeats(t *testing.T) {
	f := newFixture(t, 500)
	f.enroll(t, "a")

	tr, clock := newTracker()
	tr.Beat("a", nil)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := tr.Flush(cancelled, f.pool, f.serverID)
	require.Error(t, err)

	// The failed batch is retried by the next flush, not lost.
	clock.set(t0.Add(time.Second))
	n, err := tr.Flush(context.Background(), f.pool, f.serverID)
	require.NoError(t, err)
	require.Equal(t, 1, n)
	require.True(t, t0.Equal(f.device(t, "a").LastSeenAt), "retried value is the original beat time")
}

func TestTrackerFlushRaceWithBeats(t *testing.T) {
	f := newFixture(t, 500)
	f.enroll(t, "a")
	tr := devices.NewTracker(time.Now)

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				tr.Beat("a", []int32{1})
				_ = tr.Online("a")
			}
		}
	}()
	for i := 0; i < 20; i++ {
		_, err := tr.Flush(context.Background(), f.pool, f.serverID)
		require.NoError(t, err)
	}
	close(stop)
	wg.Wait()
}

// fakeTicks hands Run controllable tickers, one per requested interval.
type fakeTicks struct {
	mu sync.Mutex
	ch map[time.Duration]chan time.Time
}

func newFakeTicks() *fakeTicks { return &fakeTicks{ch: map[time.Duration]chan time.Time{}} }

func (f *fakeTicks) tick(d time.Duration) <-chan time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.ch[d]
	if !ok {
		c = make(chan time.Time)
		f.ch[d] = c
	}
	return c
}

// fire delivers one tick on the d ticker, waiting for Run to receive it.
func (f *fakeTicks) fire(t *testing.T, d time.Duration) {
	t.Helper()
	f.tick(d) // make sure the channel exists
	f.mu.Lock()
	send := f.ch[d]
	f.mu.Unlock()
	select {
	case send <- time.Now():
	case <-time.After(5 * time.Second):
		t.Fatalf("nobody listening on the %s ticker", d)
	}
}

func startRun(t *testing.T, tr *devices.Tracker, f *fixture,
	approved func(context.Context) ([]string, error),
	query func(context.Context, []string) (map[string]bool, error)) (cancel func(), done <-chan struct{}) {
	t.Helper()
	ctx, cancelCtx := context.WithCancel(context.Background())
	d := make(chan struct{})
	go func() {
		defer close(d)
		tr.Run(ctx, f.pool, f.serverID, approved, query)
	}()
	t.Cleanup(func() { cancelCtx(); <-d })
	return cancelCtx, d
}

func waitDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after ctx was cancelled")
	}
}

func TestTrackerProbeBatches(t *testing.T) {
	f := newFixture(t, 500)
	tr, _ := newTracker()
	ticks := newFakeTicks()
	tr.Tick = ticks.tick

	ids := make([]string, 2500)
	for i := range ids {
		ids[i] = fmt.Sprintf("%09d", i)
	}
	var (
		mu    sync.Mutex
		sizes []int
	)
	called := make(chan struct{}, 10)
	query := func(_ context.Context, batch []string) (map[string]bool, error) {
		mu.Lock()
		sizes = append(sizes, len(batch))
		mu.Unlock()
		called <- struct{}{}
		return map[string]bool{batch[0]: true}, nil
	}
	approved := func(context.Context) ([]string, error) { return ids, nil }

	cancel, done := startRun(t, tr, f, approved, query)
	ticks.fire(t, devices.ProbeEvery)
	for i := 0; i < 3; i++ {
		select {
		case <-called:
		case <-time.After(5 * time.Second):
			t.Fatal("query was not called 3 times")
		}
	}
	cancel()
	waitDone(t, done)

	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, []int{1000, 1000, 500}, sizes)
	// Each true result is recorded as online.
	require.True(t, tr.Online(ids[0]))
	require.True(t, tr.Online(ids[1000]))
	require.True(t, tr.Online(ids[2000]))
	require.False(t, tr.Online(ids[1]))
}

func TestTrackerProbeSkipsBeatingDevicesAndQueryErrors(t *testing.T) {
	f := newFixture(t, 500)
	tr, _ := newTracker()
	ticks := newFakeTicks()
	tr.Tick = ticks.tick
	tr.Beat("beating", nil)

	ids := []string{"beating"}
	for i := 0; i < 1500; i++ {
		ids = append(ids, fmt.Sprintf("%09d", i))
	}
	var (
		mu    sync.Mutex
		sizes []int
	)
	called := make(chan struct{}, 10)
	query := func(_ context.Context, batch []string) (map[string]bool, error) {
		mu.Lock()
		sizes = append(sizes, len(batch))
		first := len(sizes) == 1
		mu.Unlock()
		called <- struct{}{}
		if first {
			return nil, errors.New("hbbs down")
		}
		return map[string]bool{batch[0]: true}, nil
	}
	approved := func(context.Context) ([]string, error) { return ids, nil }

	cancel, done := startRun(t, tr, f, approved, query)
	ticks.fire(t, devices.ProbeEvery)
	for i := 0; i < 2; i++ {
		select {
		case <-called:
		case <-time.After(5 * time.Second):
			t.Fatal("a failed batch must not stop the next one")
		}
	}
	cancel()
	waitDone(t, done)

	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, []int{1000, 500}, sizes, "the beating device is not probed")
	require.False(t, tr.Online(ids[1]), "failed batch marks nothing")
	require.True(t, tr.Online(ids[1001]))
}

func TestTrackerRunWithoutQueryDoesNotProbe(t *testing.T) {
	f := newFixture(t, 500)
	tr, _ := newTracker()
	ticks := newFakeTicks()
	var asked sync.Map
	tr.Tick = func(d time.Duration) <-chan time.Time {
		asked.Store(d, true)
		return ticks.tick(d)
	}

	cancel, done := startRun(t, tr, f, func(context.Context) ([]string, error) {
		t.Error("approved must not be called when query is nil")
		return nil, nil
	}, nil)
	cancel()
	waitDone(t, done)
	_, probe := asked.Load(devices.ProbeEvery)
	require.False(t, probe)
}

func TestTrackerRunFlushesOnTick(t *testing.T) {
	f := newFixture(t, 500)
	f.enroll(t, "a")
	tr, _ := newTracker()
	ticks := newFakeTicks()
	tr.Tick = ticks.tick

	cancel, done := startRun(t, tr, f, nil, nil)
	tr.Beat("a", nil)
	ticks.fire(t, devices.FlushEvery)
	require.Eventually(t, func() bool { return t0.Equal(f.device(t, "a").LastSeenAt) },
		5*time.Second, 10*time.Millisecond)
	cancel()
	waitDone(t, done)
}

func TestTrackerRunFlushesOnStop(t *testing.T) {
	f := newFixture(t, 500)
	f.enroll(t, "a")
	tr, _ := newTracker()
	tr.Tick = newFakeTicks().tick

	cancel, done := startRun(t, tr, f, nil, nil)
	tr.Beat("a", nil)
	cancel()
	waitDone(t, done)
	require.True(t, t0.Equal(f.device(t, "a").LastSeenAt))
}

func TestTrackerProbeKeepsAskingAboutHBBSOnlineDevices(t *testing.T) {
	f := newFixture(t, 500)
	tr, clock := newTracker()
	ticks := newFakeTicks()
	tr.Tick = ticks.tick
	tr.MarkOnline([]string{"x"}) // reported by hbbs at t0

	called := make(chan []string, 4)
	query := func(_ context.Context, batch []string) (map[string]bool, error) {
		called <- batch
		return map[string]bool{"x": true}, nil
	}
	approved := func(context.Context) ([]string, error) { return []string{"x"}, nil }

	cancel, done := startRun(t, tr, f, approved, query)
	clock.set(t0.Add(devices.ProbeEvery))
	ticks.fire(t, devices.ProbeEvery)
	select {
	case got := <-called:
		require.Equal(t, []string{"x"}, got, "still-online-at-hbbs devices are re-probed")
	case <-time.After(5 * time.Second):
		t.Fatal("x was not probed")
	}
	// The re-mark is made after the query returns; wait for it, then cancel.
	cancel()
	waitDone(t, done)
	clock.set(t0.Add(devices.ProbeEvery + 104*time.Second))
	require.True(t, tr.Online("x"), "re-mark renewed the presence")
}

type change struct {
	id     string
	online bool
}

// recordChanges registers an OnChange callback on tr and returns a getter for
// the changes seen so far.
func recordChanges(tr *devices.Tracker) func() []change {
	var mu sync.Mutex
	var got []change
	tr.OnChange(func(id string, online bool) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, change{id, online})
	})
	return func() []change {
		mu.Lock()
		defer mu.Unlock()
		return append([]change(nil), got...)
	}
}

func TestTrackerOnChangeOnline(t *testing.T) {
	tr, clock := newTracker()
	got := recordChanges(tr)

	tr.Beat("a", nil)
	require.Equal(t, []change{{"a", true}}, got())
	clock.set(t0.Add(10 * time.Second))
	tr.Beat("a", nil)
	require.Len(t, got(), 1)
}

func TestTrackerOnChangeOffline(t *testing.T) {
	tr, clock := newTracker()
	got := recordChanges(tr)

	tr.Beat("a", nil)
	clock.set(t0.Add(44 * time.Second))
	tr.Sweep()
	require.Equal(t, []change{{"a", true}}, got())

	clock.set(t0.Add(46 * time.Second))
	tr.Sweep()
	require.Equal(t, []change{{"a", true}, {"a", false}}, got())
	tr.Sweep()
	require.Len(t, got(), 2)
}

func TestTrackerOnChangeHBBS(t *testing.T) {
	tr, clock := newTracker()
	got := recordChanges(tr)

	tr.MarkOnline([]string{"b"})
	require.Equal(t, []change{{"b", true}}, got())

	// Past the heartbeat window but inside the hbbs presence TTL: still online.
	clock.set(t0.Add(104 * time.Second))
	tr.Sweep()
	require.Len(t, got(), 1)

	clock.set(t0.Add(105 * time.Second))
	tr.Sweep()
	require.Equal(t, []change{{"b", true}, {"b", false}}, got())
}

func TestTrackerOnChangeBackOnline(t *testing.T) {
	tr, clock := newTracker()
	got := recordChanges(tr)

	tr.Beat("a", nil)
	clock.set(t0.Add(46 * time.Second))
	tr.Sweep()
	tr.Beat("a", nil)
	require.Equal(t, []change{{"a", true}, {"a", false}, {"a", true}}, got())
}

func TestTrackerOnChangeOutsideLock(t *testing.T) {
	tr, clock := newTracker()
	var calls atomic.Int32
	// The callback calls back into the tracker; it would deadlock if mu were
	// held.
	tr.OnChange(func(id string, online bool) {
		calls.Add(1)
		tr.Online(id)
		tr.Conns(id)
	})

	finished := make(chan struct{})
	go func() {
		defer close(finished)
		tr.Beat("a", nil)
		tr.MarkOnline([]string{"b"})
		clock.set(t0.Add(106 * time.Second))
		tr.Sweep()
	}()
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("callback deadlocked")
	}
	require.EqualValues(t, 4, calls.Load(), "two online and two offline callbacks")
}

func TestTrackerRunSweeps(t *testing.T) {
	f := newFixture(t, 500)
	tr, clock := newTracker()
	ticks := newFakeTicks()
	tr.Tick = ticks.tick
	got := recordChanges(tr)

	cancel, done := startRun(t, tr, f, nil, nil)
	tr.Beat("a", nil)
	clock.set(t0.Add(46 * time.Second))
	ticks.fire(t, devices.SweepEvery)
	require.Eventually(t, func() bool { return len(got()) == 2 },
		5*time.Second, 10*time.Millisecond)
	require.Equal(t, []change{{"a", true}, {"a", false}}, got())
	cancel()
	waitDone(t, done)
}

func TestTrackerOnChangeOrderedUnderConcurrency(t *testing.T) {
	tr, clock := newTracker()
	got := recordChanges(tr)

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				clock.set(t0.Add(time.Duration(i%100) * time.Second))
				if i%3 == 0 {
					tr.Sweep()
				} else {
					tr.Beat("a", nil)
				}
			}
		}()
	}
	wg.Wait()

	changes := got()
	require.NotEmpty(t, changes)
	for i, c := range changes {
		require.Equal(t, i%2 == 0, c.online, "events alternate online/offline starting online")
	}
	// Bring the tracker to a settled state, then compare the last event to it.
	tr.Sweep()
	changes = got()
	require.Equal(t, tr.Online("a"), changes[len(changes)-1].online)
}
