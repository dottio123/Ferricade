package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	totpIssuer     = "ferricade"
	totpDigits     = 6
	totpPeriod     = 30
	totpSecretLen  = 20
	totpWindowStep = 1
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewTOTPSecret returns a fresh 20-byte secret as unpadded base32.
func NewTOTPSecret() (string, error) {
	raw := make([]byte, totpSecretLen)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("auth: read totp secret: %w", err)
	}
	return b32.EncodeToString(raw), nil
}

// TOTPURL builds the otpauth provisioning URL for an authenticator app.
func TOTPURL(account, secret string) string {
	return fmt.Sprintf("otpauth://totp/%s:%s?secret=%s&issuer=%s&algorithm=SHA1&digits=%d&period=%d",
		totpIssuer, url.PathEscape(account), url.QueryEscape(secret), totpIssuer, totpDigits, totpPeriod)
}

// TOTPCode returns the code for secret at time at. The console itself only
// verifies codes; this is for tests and tools that act as an authenticator.
func TOTPCode(secret string, at time.Time) (string, error) {
	key, err := b32.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil || len(key) == 0 {
		return "", fmt.Errorf("auth: invalid totp secret")
	}
	return hotp(key, uint64(at.Unix()/totpPeriod)), nil
}

// hotp is RFC 4226 HOTP with SHA-1 and dynamic truncation, 6 digits.
func hotp(key []byte, counter uint64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	bin := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%0*d", totpDigits, bin%1000000)
}

// VerifyTOTP checks code against steps now-1, now and now+1 and returns the
// matching step. Only steps strictly greater than lastStep are accepted, so a
// code cannot be replayed. On mismatch or malformed input it returns (0, false).
func VerifyTOTP(secret, code string, now time.Time, lastStep int64) (int64, bool) {
	if len(code) != totpDigits {
		return 0, false
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	key, err := b32.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil || len(key) == 0 {
		return 0, false
	}
	cur := now.Unix() / totpPeriod
	for step := cur - totpWindowStep; step <= cur+totpWindowStep; step++ {
		if step < 0 || step <= lastStep {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(hotp(key, uint64(step))), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}
