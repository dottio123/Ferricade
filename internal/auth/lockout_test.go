package auth

import (
	"fmt"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestLockDuration(t *testing.T) {
	cases := map[int]time.Duration{
		-1:   0,
		0:    0,
		4:    0,
		5:    time.Minute,
		6:    2 * time.Minute,
		7:    4 * time.Minute,
		10:   32 * time.Minute,
		11:   time.Hour, // 64m capped
		20:   time.Hour,
		70:   time.Hour, // shift would overflow
		1000: time.Hour,
	}
	for failures, want := range cases {
		require.Equal(t, want, LockDuration(failures), "failures=%d", failures)
	}
}

func TestIPLimiter(t *testing.T) {
	clk := newClock()
	l := NewIPLimiter(clk.Now)
	ip := netip.MustParseAddr("198.51.100.1")
	other := netip.MustParseAddr("198.51.100.2")

	for i := 0; i < 19; i++ {
		l.Fail(ip)
	}
	require.False(t, l.Blocked(ip))
	l.Fail(ip)
	require.True(t, l.Blocked(ip))
	require.False(t, l.Blocked(other))

	clk.Advance(10*time.Minute + time.Second)
	require.False(t, l.Blocked(ip))
}

func TestIPLimiterSlidingWindow(t *testing.T) {
	clk := newClock()
	l := NewIPLimiter(clk.Now)
	ip := netip.MustParseAddr("2001:db8::1")

	for i := 0; i < 10; i++ {
		l.Fail(ip)
	}
	clk.Advance(5 * time.Minute)
	for i := 0; i < 10; i++ {
		l.Fail(ip)
	}
	require.True(t, l.Blocked(ip))
	// The first ten age out; the last ten remain.
	clk.Advance(5*time.Minute + time.Second)
	require.False(t, l.Blocked(ip))
	for i := 0; i < 10; i++ {
		l.Fail(ip)
	}
	require.True(t, l.Blocked(ip))
}

func TestIPLimiterMappedAddressesShareCounter(t *testing.T) {
	clk := newClock()
	l := NewIPLimiter(clk.Now)
	v4 := netip.MustParseAddr("203.0.113.5")
	mapped := netip.MustParseAddr("::ffff:203.0.113.5")
	for i := 0; i < 10; i++ {
		l.Fail(v4)
		l.Fail(mapped)
	}
	require.True(t, l.Blocked(v4))
	require.True(t, l.Blocked(mapped))
}

func TestIPLimiterForgetsIdleAddresses(t *testing.T) {
	clk := newClock()
	l := NewIPLimiter(clk.Now)
	for i := 0; i < 100; i++ {
		l.Fail(netip.AddrFrom4([4]byte{10, 0, byte(i >> 8), byte(i)}))
	}
	clk.Advance(ipWindow + time.Second)
	l.Fail(netip.MustParseAddr("10.1.0.1"))
	l.mu.Lock()
	n := len(l.fails)
	l.mu.Unlock()
	require.Equal(t, 1, n)
}

func TestLockoutsFollowAccountSchedule(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	l := NewLockouts(131_072)
	for i := 1; i <= 4; i++ {
		require.False(t, l.Fail("ghost", now), "failure %d does not lock", i)
		require.False(t, l.Locked("ghost", now))
	}
	require.True(t, l.Fail("ghost", now), "the fifth failure locks, as for a real account")
	require.True(t, l.Locked("ghost", now))
	require.True(t, l.Locked("ghost", now.Add(time.Minute-time.Microsecond)))
	require.False(t, l.Locked("ghost", now.Add(time.Minute)), "5 failures lock for 1 min")

	now = now.Add(time.Minute)
	require.True(t, l.Fail("ghost", now), "the count is kept after the lock, as in the database")
	require.True(t, l.Locked("ghost", now.Add(2*time.Minute-time.Microsecond)), "6 failures lock for 2 min")
	require.False(t, l.Locked("ghost", now.Add(2*time.Minute)))

	for i := 7; i <= 12; i++ {
		now = now.Add(30 * time.Minute)
		require.True(t, l.Fail("ghost", now))
		require.True(t, l.Locked("ghost", now.Add(LockDuration(i)-time.Microsecond)))
		require.False(t, l.Locked("ghost", now.Add(LockDuration(i))))
	}
	now = now.Add(time.Hour)
	require.False(t, l.Fail("ghost", now), "an hour without failures resets the count")
	require.False(t, l.Locked("ghost", now))
}

func TestLockoutsNeverEvictUnderFlood(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	l := NewLockouts(2)
	lock := func(k string) {
		for i := 0; i < 5; i++ {
			l.Fail(k, now)
		}
	}
	lock("ghost")
	for i := 0; i <= 10_000; i++ {
		l.Fail(fmt.Sprintf("spray%d", i), now)
	}
	require.True(t, l.Locked("ghost", now), "a flood must never unlock an existing key")
}

func TestLockoutsConcurrent(t *testing.T) {
	l := NewLockouts(100)
	now := time.Now()
	done := make(chan struct{})
	for g := 0; g < 8; g++ {
		go func(g int) {
			defer func() { done <- struct{}{} }()
			for i := 0; i < 200; i++ {
				k := string(rune('a' + (i+g)%26))
				l.Fail(k, now)
				l.Locked(k, now)
			}
		}(g)
	}
	for g := 0; g < 8; g++ {
		<-done
	}
	require.Len(t, l.buckets, 100)
}

func TestIPLimiterCapsDistinctKeys(t *testing.T) {
	l := NewIPLimiter(nil)
	for i := 0; i < 100_000; i++ {
		ip := netip.AddrFrom4([4]byte{198, byte(i >> 16), byte(i >> 8), byte(i)})
		if !l.Begin(ip) {
			t.Fatalf("Begin refused key %d before the cap", i)
		}
		l.End(ip, true)
	}
	last := netip.AddrFrom4([4]byte{198, 1, 134, 160}) // 100,000th zero-based key + 1
	if l.Begin(last) {
		l.End(last, true)
		t.Fatal("Begin accepted a new key at the cap")
	}
	if len(l.fails) > 100_000 {
		t.Fatalf("tracked %d keys; maximum is 100000", len(l.fails))
	}
}

func TestIPLimiterBeginCountsInFlightAttempts(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	l := NewIPLimiter(func() time.Time { return now })
	ip := netip.MustParseAddr("192.0.2.1")
	for i := 0; i < 20; i++ {
		require.True(t, l.Begin(ip), "attempt %d", i+1)
	}
	require.False(t, l.Begin(ip), "20 in flight")
	require.False(t, l.Blocked(ip), "nothing has failed yet")
	l.End(ip, false)
	require.True(t, l.Begin(netip.MustParseAddr("::ffff:192.0.2.1")), "a success frees its slot; mapped form shares it")
	for i := 0; i < 20; i++ {
		l.End(ip, true)
	}
	require.True(t, l.Blocked(ip))
	require.False(t, l.Begin(ip))
	l.mu.Lock()
	require.Empty(t, l.inflight)
	l.mu.Unlock()
}

func TestIPLimiterBeginConcurrentBurst(t *testing.T) {
	l := NewIPLimiter(nil)
	ip := netip.MustParseAddr("192.0.2.1")
	var mu sync.Mutex
	evaluated := 0
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 60; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if !l.Begin(ip) {
				return
			}
			mu.Lock()
			evaluated++
			mu.Unlock()
			time.Sleep(time.Millisecond)
			l.End(ip, true)
		}()
	}
	close(start)
	wg.Wait()
	require.LessOrEqual(t, evaluated, 20)
	require.True(t, l.Blocked(ip))
}
