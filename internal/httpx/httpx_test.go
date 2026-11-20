package httpx

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func reqFrom(peer, xff string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.RemoteAddr = peer
	if xff != "" {
		r.Header.Set("X-Forwarded-For", xff)
	}
	return r
}

var trusted = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}

func TestClientIPUntrustedPeerIgnoresXFF(t *testing.T) {
	got := ClientIP(reqFrom("203.0.113.9:5555", "1.2.3.4"), trusted)
	assert.Equal(t, netip.MustParseAddr("203.0.113.9"), got)
}

func TestClientIPTrustedPeer(t *testing.T) {
	got := ClientIP(reqFrom("10.0.0.2:5555", "1.2.3.4, 10.0.0.3"), trusted)
	assert.Equal(t, netip.MustParseAddr("1.2.3.4"), got)
}

func TestClientIPStopsBeforeMalformedOlderHop(t *testing.T) {
	got := ClientIP(reqFrom("10.0.0.2:5555", "garbage, 1.2.3.4"), trusted)
	assert.Equal(t, netip.MustParseAddr("1.2.3.4"), got)
}

func TestClientIPTrustedPeerEdgeCases(t *testing.T) {
	peer := netip.MustParseAddr("10.0.0.2")
	tests := []struct {
		name, xff string
		want      netip.Addr
	}{
		{"no header", "", peer},
		{"all trusted", "10.1.1.1, 10.2.2.2", peer},
		{"malformed entry", "1.2.3.4, bogus", peer},
		{"spoofed left entries ignored", "6.6.6.6, 1.2.3.4, 10.0.0.3", netip.MustParseAddr("1.2.3.4")},
		{"ipv4-mapped ipv6", "::ffff:1.2.3.4", netip.MustParseAddr("1.2.3.4")},
		{"empty entry", "1.2.3.4,,10.0.0.3", peer},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, ClientIP(reqFrom("10.0.0.2:5555", tc.xff), trusted))
		})
	}
}

func TestClientIPMultipleHeaderLines(t *testing.T) {
	r := reqFrom("10.0.0.2:5555", "")
	r.Header.Add("X-Forwarded-For", "9.9.9.9")
	r.Header.Add("X-Forwarded-For", "1.2.3.4, 10.0.0.3")
	assert.Equal(t, netip.MustParseAddr("1.2.3.4"), ClientIP(r, trusted))
}

func TestClientIPUnmapsPeer(t *testing.T) {
	got := ClientIP(reqFrom("[::ffff:203.0.113.9]:5555", ""), nil)
	assert.Equal(t, netip.MustParseAddr("203.0.113.9"), got)
	// A mapped peer is matched against IPv4 prefixes.
	got = ClientIP(reqFrom("[::ffff:10.0.0.2]:5555", "1.2.3.4"), trusted)
	assert.Equal(t, netip.MustParseAddr("1.2.3.4"), got)
}

func TestClientIPUnparsablePeer(t *testing.T) {
	assert.False(t, ClientIP(reqFrom("garbage", "1.2.3.4"), trusted).IsValid())
}

func byPeer(r *http.Request) netip.Addr { return ClientIP(r, nil) }

func limited(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTooManyRequests) }

func ok(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }

func codes(h http.Handler, peer string, n int) []int {
	var out []int
	for i := 0; i < n; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, reqFrom(peer, ""))
		out = append(out, rec.Code)
	}
	return out
}

func TestRateLimit(t *testing.T) {
	h := RateLimit(1, 2, byPeer, limited)(http.HandlerFunc(ok))
	assert.Equal(t, []int{200, 200, 429}, codes(h, "203.0.113.9:1", 3))
	// Another key has its own bucket.
	assert.Equal(t, []int{200, 200, 429}, codes(h, "203.0.113.10:1", 3))
}

func TestRateLimiterEvictsIdleKeys(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	l := newLimiter(1, 1, func() time.Time { return now })
	a, b := netip.MustParseAddr("192.0.2.1"), netip.MustParseAddr("192.0.2.2")
	assert.True(t, l.allow(a))
	assert.False(t, l.allow(a))
	now = now.Add(5 * time.Minute)
	assert.True(t, l.allow(b))
	assert.Equal(t, 2, l.size())
	now = now.Add(6 * time.Minute) // a idle 11 min, b idle 6 min
	assert.True(t, l.allow(b))
	assert.Equal(t, 1, l.size(), "a evicted")
	assert.True(t, l.allow(a), "a starts over with a full bucket")
}

func TestRateLimiterConcurrent(t *testing.T) {
	l := newLimiter(1000, 1000, time.Now)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			a := netip.AddrFrom4([4]byte{192, 0, 2, byte(i % 3)})
			for j := 0; j < 200; j++ {
				l.allow(a)
			}
		}(i)
	}
	wg.Wait()
}

func TestRateLimiterKeysIPv6ByPrefix64(t *testing.T) {
	l := newLimiter(1, 1, time.Now)
	assert.True(t, l.allow(netip.MustParseAddr("2001:db8:1:2::1")))
	assert.False(t, l.allow(netip.MustParseAddr("2001:db8:1:2:ffff::9")), "same /64 shares a bucket")
	assert.True(t, l.allow(netip.MustParseAddr("2001:db8:1:3::1")), "other /64 has its own")
	assert.Equal(t, 2, l.size())
}

func TestRateLimiterIPv4MappedSharesBucketWithIPv4(t *testing.T) {
	l := newLimiter(1, 1, time.Now)
	assert.True(t, l.allow(netip.MustParseAddr("192.0.2.1")))
	assert.False(t, l.allow(netip.MustParseAddr("::ffff:192.0.2.1")))
	assert.True(t, l.allow(netip.MustParseAddr("192.0.2.2")), "IPv4 keys are per address")
}

func TestRateLimiterInvalidKeysShareOneBucket(t *testing.T) {
	l := newLimiter(1, 1, time.Now)
	assert.True(t, l.allow(netip.Addr{}))
	assert.False(t, l.allow(netip.Addr{}))
	assert.Equal(t, 1, l.size())
}

func TestRateLimiterCap(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	l := newLimiter(1, 1, func() time.Time { return now })
	l.maxKeys = 3
	addr := func(i byte) netip.Addr { return netip.AddrFrom4([4]byte{192, 0, 2, i}) }
	for i := byte(1); i <= 3; i++ {
		assert.True(t, l.allow(addr(i)))
	}
	assert.False(t, l.allow(addr(4)), "new key at the cap fails closed")
	assert.Equal(t, 3, l.size())
	assert.False(t, l.allow(addr(1)), "existing keys keep being limited normally")

	now = now.Add(11 * time.Minute) // all idle: a new key sweeps and fits
	assert.True(t, l.allow(addr(4)))
	assert.Equal(t, 1, l.size())
}

func TestLimitKey(t *testing.T) {
	assert.Equal(t, netip.MustParseAddr("192.0.2.1"), LimitKey(netip.MustParseAddr("::ffff:192.0.2.1")))
	assert.Equal(t, netip.MustParseAddr("2001:db8:1:2::"), LimitKey(netip.MustParseAddr("2001:db8:1:2:ffff::9")))
	assert.False(t, LimitKey(netip.Addr{}).IsValid())
}
