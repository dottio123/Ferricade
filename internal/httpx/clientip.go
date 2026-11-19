// Package httpx holds HTTP helpers shared by the listeners: client IP
// resolution and per-IP rate limiting.
package httpx

import (
	"net/http"
	"net/netip"
	"strings"
)

// ClientIP returns the address of the client that made r.
//
// The immediate peer is the answer unless it is inside trusted. For a trusted
// peer, X-Forwarded-For is walked right to left and the first address outside
// trusted wins, so entries a client prepends itself are never believed. When
// every entry is trusted, or the header is absent or malformed, the peer is
// returned. IPv4-mapped IPv6 addresses are unmapped. The result is the zero
// Addr when the peer address cannot be parsed.
func ClientIP(r *http.Request, trusted []netip.Prefix) netip.Addr {
	peer := peerAddr(r.RemoteAddr)
	if !peer.IsValid() || !contains(trusted, peer) {
		return peer
	}
	header := strings.Join(r.Header.Values("X-Forwarded-For"), ",")
	if header == "" {
		return peer
	}
	hops := strings.Split(header, ",")
	for i := len(hops) - 1; i >= 0; i-- {
		h := hops[i]
		a, err := netip.ParseAddr(strings.TrimSpace(h))
		if err != nil {
			return peer
		}
		a = normalize(a)
		if !contains(trusted, a) {
			return a
		}
	}
	return peer
}

func peerAddr(remote string) netip.Addr {
	if ap, err := netip.ParseAddrPort(remote); err == nil {
		return normalize(ap.Addr())
	}
	if a, err := netip.ParseAddr(remote); err == nil {
		return normalize(a)
	}
	return netip.Addr{}
}

func normalize(a netip.Addr) netip.Addr { return a.Unmap().WithZone("") }

func contains(prefixes []netip.Prefix, a netip.Addr) bool {
	for _, p := range prefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}
