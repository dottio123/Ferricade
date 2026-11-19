// Package setup runs the first-run wizard: the one-time setup token, the
// owner account and its TOTP, the server profile, and the setup_complete flag.
package setup

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"time"
)

// TokenTTL is how long a setup token stays valid after it is issued.
const TokenTTL = 24 * time.Hour

// Guard checks the setup token. Only the token's SHA-256 is kept.
type Guard struct {
	sum     [sha256.Size]byte
	expires time.Time
	now     func() time.Time
}

// NewGuard issues a new setup token, 32 random bytes in unpadded base64url,
// valid for TokenTTL from now(). A nil now means time.Now. The caller logs the
// token once and keeps only the Guard.
func NewGuard(now func() time.Time) (string, *Guard) {
	if now == nil {
		now = time.Now
	}
	var raw [32]byte
	_, _ = rand.Read(raw[:]) // crypto/rand.Read never fails
	token := base64.RawURLEncoding.EncodeToString(raw[:])
	return token, &Guard{sum: sha256.Sum256([]byte(token)), expires: now().Add(TokenTTL), now: now}
}

// Valid reports whether token is the setup token and has not expired. A token
// is rejected from exactly TokenTTL after issue. The comparison is of SHA-256
// digests in constant time. A nil Guard accepts nothing.
func (g *Guard) Valid(token string) bool {
	if g == nil || !g.now().Before(g.expires) {
		return false
	}
	sum := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(sum[:], g.sum[:]) == 1
}
