package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"net/netip"
	"sync"
	"time"
)

// Account lockout: lockThreshold consecutive failures lock the account for
// lockBase, and each further failure doubles the lock, up to lockMax.
const (
	lockThreshold = 5
	lockBase      = time.Minute
	lockMax       = time.Hour
)

// LockDuration returns how long an account with the given number of
// consecutive failed logins stays locked: 0 below 5, then 1 min doubling per
// further failure, capped at 1 h.
func LockDuration(failures int) time.Duration {
	if failures < lockThreshold {
		return 0
	}
	shift := failures - lockThreshold
	// lockBase<<6 already exceeds lockMax; checking first avoids overflow.
	if shift >= 6 {
		return lockMax
	}
	return min(lockBase<<shift, lockMax)
}

// Per-IP limit: ipMaxFailures failed logins within a sliding ipWindow block
// the address.
const (
	ipMaxFailures    = 20
	ipWindow         = 10 * time.Minute
	maxIPLimiterKeys = 100_000
)

// IPLimiter counts failed logins per client address in memory. It is safe for
// concurrent use.
//
// Handlers reserve each attempt with Begin before checking credentials and
// resolve it with End, so a burst of parallel requests cannot all pass the
// check before any failure is recorded: an attempt in flight counts towards
// the limit until it ends.
type IPLimiter struct {
	now func() time.Time

	mu        sync.Mutex
	fails     map[netip.Addr][]time.Time // oldest first, at most ipMaxFailures
	inflight  map[netip.Addr]int         // attempts begun and not yet ended
	keys      map[netip.Addr]struct{}    // failure or in-flight keys, capped at maxIPLimiterKeys
	lastSweep time.Time
}

// NewIPLimiter returns a limiter that reads the time from now (nil means
// time.Now).
func NewIPLimiter(now func() time.Time) *IPLimiter {
	if now == nil {
		now = time.Now
	}
	return &IPLimiter{now: now, fails: make(map[netip.Addr][]time.Time), inflight: make(map[netip.Addr]int), keys: make(map[netip.Addr]struct{})}
}

// Begin reserves an attempt from ip. It returns false, reserving nothing, when
// ip's failures in the last 10 minutes plus its attempts still in flight
// already reach 20. Every true must be followed by exactly one End.
func (l *IPLimiter) Begin(ip netip.Addr) bool {
	now := l.now()
	key := limiterKey(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweep(now)
	if _, ok := l.keys[key]; !ok {
		if len(l.keys) >= maxIPLimiterKeys {
			return false
		}
		l.keys[key] = struct{}{}
	}
	if len(recent(l.fails[key], now))+l.inflight[key] >= ipMaxFailures {
		return false
	}
	l.inflight[key]++
	return true
}

// End resolves an attempt reserved by Begin, recording a failure when failed
// is true. The attempt turns into the failure atomically, so it never stops
// counting in between.
func (l *IPLimiter) End(ip netip.Addr, failed bool) {
	now := l.now()
	key := limiterKey(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	if n := l.inflight[key]; n <= 1 {
		delete(l.inflight, key)
	} else {
		l.inflight[key] = n - 1
	}
	if failed {
		l.fail(key, now)
	} else if len(recent(l.fails[key], now)) == 0 {
		delete(l.fails, key)
		delete(l.keys, key)
	}
}

// limiterKey normalises ip so an IPv4 address and its IPv4-mapped IPv6 form,
// or the same address with different zones, share one counter.
func limiterKey(ip netip.Addr) netip.Addr {
	return ip.Unmap().WithZone("")
}

// Fail records a failed login from ip.
func (l *IPLimiter) Fail(ip netip.Addr) {
	now := l.now()
	key := limiterKey(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.fail(key, now)
}

// fail records a failure for key at now. The caller holds l.mu.
func (l *IPLimiter) fail(key netip.Addr, now time.Time) {
	l.sweep(now)
	if _, ok := l.keys[key]; !ok {
		if len(l.keys) >= maxIPLimiterKeys {
			return
		}
		l.keys[key] = struct{}{}
	}
	ts := recent(l.fails[key], now)
	// Only the newest ipMaxFailures timestamps can decide Blocked, so older
	// ones are dropped to bound memory per address.
	if len(ts) == ipMaxFailures {
		ts = append(ts[:0], ts[1:]...)
	}
	l.fails[key] = append(ts, now)
}

// Blocked reports whether ip has at least 20 failed logins in the last 10
// minutes.
func (l *IPLimiter) Blocked(ip netip.Addr) bool {
	now := l.now()
	key := limiterKey(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(recent(l.fails[key], now)) >= ipMaxFailures
}

// recent returns the suffix of ts (oldest first) still inside the window
// ending at now. A failure ages out once ipWindow has passed.
func recent(ts []time.Time, now time.Time) []time.Time {
	i := 0
	for i < len(ts) && now.Sub(ts[i]) >= ipWindow {
		i++
	}
	return ts[i:]
}

// sweep drops addresses with no failure inside the window, at most once per
// window, so addresses that stop failing do not accumulate. The caller holds
// l.mu.
func (l *IPLimiter) sweep(now time.Time) {
	if now.Sub(l.lastSweep) < ipWindow {
		return
	}
	l.lastSweep = now
	for k, ts := range l.fails {
		if len(recent(ts, now)) == 0 {
			delete(l.fails, k)
			if l.inflight[k] == 0 {
				delete(l.keys, k)
			}
		}
	}
}

// Lockouts counts unknown-username failures in fixed buckets. A keyed hash
// prevents choosing collisions; collisions only add failures, never evict them.
// Counts expire lockMax after the last failure. It is safe for concurrent use.
type Lockouts struct {
	mu      sync.Mutex
	seed    [32]byte
	buckets []lockoutEntry
}

type lockoutEntry struct {
	failures   int
	until      int64
	lastFailed int64
}

// NewLockouts returns a Lockouts with a fixed number of buckets (at least one).
func NewLockouts(buckets int) *Lockouts {
	l := &Lockouts{buckets: make([]lockoutEntry, max(1, buckets))}
	// crypto/rand.Read always fills the buffer or terminates the process.
	rand.Read(l.seed[:])
	return l
}

// entry returns key's bucket. The caller holds l.mu.
func (l *Lockouts) entry(key string) *lockoutEntry {
	h := hmac.New(sha256.New, l.seed[:])
	h.Write([]byte(key))
	index := binary.LittleEndian.Uint64(h.Sum(nil)) % uint64(len(l.buckets))
	return &l.buckets[index]
}

// Locked reports whether key's bucket is locked at now.
func (l *Lockouts) Locked(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return now.UnixNano() < l.entry(key).until
}

// Fail counts a failure and extends the lock on the account schedule.
func (l *Lockouts) Fail(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.entry(key)
	if now.UnixNano()-e.lastFailed >= int64(lockMax) {
		e.failures = 0
	}
	// Beyond 11 failures the backoff stays capped; the count need not grow.
	e.failures = min(e.failures+1, 11)
	e.lastFailed = now.UnixNano()
	if d := LockDuration(e.failures); d > 0 {
		e.until = max(e.until, now.Add(d).UnixNano())
		return true
	}
	return false
}
