package httpx

import (
	"net/http"
	"net/netip"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

const (
	// idleEvict is how long a key may go unseen before its bucket is dropped.
	idleEvict = 10 * time.Minute
	// sweepEvery is the least time between two routine sweeps for idle keys.
	sweepEvery = time.Minute
	// capSweepEvery is the least time between two sweeps forced by a full
	// map, so a flood of new keys cannot make every request an O(n) sweep.
	capSweepEvery = time.Second
	// maxKeys caps the number of buckets held at once.
	maxKeys = 100_000
	// v6Bits is the IPv6 prefix length that shares one bucket: a single
	// subscriber normally owns a /64, so per-address keys would be free to mint.
	v6Bits = 64
)

// RateLimit returns middleware that gives every key(r) its own token bucket
// of rps tokens per second with the given burst. IPv4 keys are used as is and
// IPv6 keys are masked to their /64; an invalid key shares one bucket. A
// request that finds its bucket empty is passed to onLimit instead of the next
// handler. Buckets idle for 10 minutes are dropped, and at most 100,000 are
// held: a new key arriving at the cap, after idle keys are swept, is refused
// (fail closed). The middleware is safe for concurrent use.
func RateLimit(rps float64, burst int, key func(*http.Request) netip.Addr, onLimit http.HandlerFunc) func(http.Handler) http.Handler {
	l := newLimiter(rps, burst, time.Now)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !l.allow(key(r)) {
				onLimit(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

type bucket struct {
	lim  *rate.Limiter
	seen time.Time
}

type limiter struct {
	rps     rate.Limit
	burst   int
	now     func() time.Time
	maxKeys int

	mu        sync.Mutex
	buckets   map[netip.Addr]*bucket
	lastSweep time.Time
}

func newLimiter(rps float64, burst int, now func() time.Time) *limiter {
	return &limiter{
		rps: rate.Limit(rps), burst: burst, now: now, maxKeys: maxKeys,
		buckets: map[netip.Addr]*bucket{}, lastSweep: now(),
	}
}

// LimitKey maps a client address to the key that per-client limits should
// count it under: an IPv4 address as is (unmapped, without zone), an IPv6
// address masked to its /64, and the zero Addr for an invalid one.
func LimitKey(a netip.Addr) netip.Addr { return bucketKey(a) }

// bucketKey maps a client address to the key that owns its bucket.
func bucketKey(a netip.Addr) netip.Addr {
	if !a.IsValid() {
		return netip.Addr{}
	}
	a = normalize(a)
	if a.Is6() {
		return netip.PrefixFrom(a, v6Bits).Masked().Addr()
	}
	return a
}

func (l *limiter) allow(addr netip.Addr) bool {
	k := bucketKey(addr)
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.lastSweep) >= sweepEvery {
		l.sweep(now)
	}
	b, ok := l.buckets[k]
	if !ok {
		if len(l.buckets) >= l.maxKeys && now.Sub(l.lastSweep) >= capSweepEvery {
			l.sweep(now)
		}
		if len(l.buckets) >= l.maxKeys {
			return false
		}
		b = &bucket{lim: rate.NewLimiter(l.rps, l.burst)}
		l.buckets[k] = b
	}
	b.seen = now
	return b.lim.AllowN(now, 1)
}

// sweep drops idle buckets. Callers hold l.mu.
func (l *limiter) sweep(now time.Time) {
	l.lastSweep = now
	for k, b := range l.buckets {
		if now.Sub(b.seen) >= idleEvict {
			delete(l.buckets, k)
		}
	}
}

func (l *limiter) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
