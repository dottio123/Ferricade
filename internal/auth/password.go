// Package auth implements password hashing, TOTP and secret sealing for the
// admin console.
package auth

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// Params are the Argon2id cost and size parameters.
type Params struct {
	Memory      uint32 // KiB
	Iterations  uint32
	Parallelism uint8
	SaltLen     uint32
	KeyLen      uint32
}

// DefaultParams are the production parameters.
var DefaultParams = Params{Memory: 65536, Iterations: 3, Parallelism: 2, SaltLen: 16, KeyLen: 32}

// TestParams are deliberately cheap parameters for tests only.
var TestParams = Params{Memory: 64, Iterations: 1, Parallelism: 1, SaltLen: 16, KeyLen: 32}

// Password policy errors returned by ValidatePassword.
var (
	ErrPasswordTooShort   = errors.New("password must be at least 12 characters")
	ErrPasswordCommon     = errors.New("password is too common")
	ErrPasswordIsUsername = errors.New("password must not equal the username")
)

const minPasswordLen = 12

var b64 = base64.RawStdEncoding.Strict()

// HashPassword returns a PHC string:
// $argon2id$v=19$m=<m>,t=<t>,p=<p>$<b64 salt>$<b64 hash>. The hash is
// computed under the Argon2id semaphore (AcquireArgonSlot): ErrBusy when no
// slot frees up in time.
func HashPassword(ctx context.Context, pw string, p Params) (string, error) {
	return hashPassword(ctx, pw, p, true)
}

// hashPassword is HashPassword; with bounded false it waits for an Argon2id
// slot until ctx ends.
func hashPassword(ctx context.Context, pw string, p Params, bounded bool) (string, error) {
	if p.Memory < minMemoryKiB || p.Memory > maxMemoryKiB || p.Iterations < 1 || p.Iterations > maxIterations ||
		p.Parallelism < 1 || p.Parallelism > maxParallelism ||
		p.SaltLen < minSaltLen || p.SaltLen > maxSaltLen || p.KeyLen < minKeyLen || p.KeyLen > maxKeyLen {
		return "", errors.New("auth: invalid argon2 params")
	}
	salt := make([]byte, p.SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: read salt: %w", err)
	}
	release, err := acquireArgonSlot(ctx, bounded)
	if err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(pw), salt, p.Iterations, p.Memory, p.Parallelism, p.KeyLen)
	release()
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.Memory, p.Iterations, p.Parallelism, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// Bounds on parameters read from a stored hash. A crafted or corrupt row must
// not be able to make VerifyPassword allocate gigabytes, spin for hours or
// spawn many goroutines, nor weaken the comparison.
const (
	minMemoryKiB           = 8
	maxMemoryKiB           = 1 << 20 // 1 GiB
	maxIterations          = 10
	maxParallelism         = 16
	minSaltLen, maxSaltLen = 8, 64
	minKeyLen, maxKeyLen   = 16, 64
)

var errMalformedHash = errors.New("auth: malformed password hash")

// parseCanonicalUint parses a base-10 unsigned integer in canonical form: only
// digits, no sign, no spaces, no leading zeros.
func parseCanonicalUint(s string, bits int) (uint64, bool) {
	v, err := strconv.ParseUint(s, 10, bits)
	if err != nil || strconv.FormatUint(v, 10) != s {
		return 0, false
	}
	return v, true
}

// parseParam parses "<name>=<canonical uint>".
func parseParam(s, name string, bits int) (uint64, bool) {
	val, ok := strings.CutPrefix(s, name+"=")
	if !ok {
		return 0, false
	}
	return parseCanonicalUint(val, bits)
}

// VerifyPassword checks pw against a PHC string produced by HashPassword. The
// cost parameters are read from encoded, not from DefaultParams, and the hash
// comparison is constant time. The encoding must be canonical and its
// parameters within fixed bounds; anything else returns an error before any
// hashing is attempted. The hash is computed under the Argon2id semaphore
// (AcquireArgonSlot): ErrBusy when no slot frees up in time.
func VerifyPassword(ctx context.Context, encoded, pw string) (bool, error) {
	parts := strings.Split(encoded, "$")
	// "", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false, errMalformedHash
	}
	kv := strings.Split(parts[3], ",")
	if len(kv) != 3 {
		return false, errMalformedHash
	}
	m, okM := parseParam(kv[0], "m", 32)
	t, okT := parseParam(kv[1], "t", 32)
	p, okP := parseParam(kv[2], "p", 8)
	if !okM || !okT || !okP {
		return false, errMalformedHash
	}
	if m < minMemoryKiB || m > maxMemoryKiB || t < 1 || t > maxIterations || p < 1 || p > maxParallelism {
		return false, errors.New("auth: password hash params out of range")
	}
	salt, err := b64.DecodeString(parts[4])
	if err != nil || len(salt) < minSaltLen || len(salt) > maxSaltLen {
		return false, errMalformedHash
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil || len(want) < minKeyLen || len(want) > maxKeyLen {
		return false, errMalformedHash
	}
	release, err := AcquireArgonSlot(ctx)
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(pw), salt, uint32(t), uint32(m), uint8(p), uint32(len(want)))
	release()
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// IsWeakPassword reports whether err is one of ValidatePassword's policy
// errors.
func IsWeakPassword(err error) bool {
	return errors.Is(err, ErrPasswordTooShort) || errors.Is(err, ErrPasswordCommon) ||
		errors.Is(err, ErrPasswordIsUsername)
}

// ErrInvalidUsername is returned by ValidateUsername.
var ErrInvalidUsername = errors.New("username must be 1 to 64 characters: letters, digits, '.', '_', '-' or '@'")

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9._@-]{1,64}$`)

// ValidateUsername checks that u is 1 to 64 ASCII letters, digits, '.', '_',
// '-' or '@'.
func ValidateUsername(u string) error {
	if !usernamePattern.MatchString(u) {
		return ErrInvalidUsername
	}
	return nil
}

// ValidatePassword enforces the password policy: at least 12 characters, not a
// common password, and not equal to the username (case-insensitive).
func ValidatePassword(username, pw string) error {
	if utf8.RuneCountInString(pw) < minPasswordLen {
		return ErrPasswordTooShort
	}
	if strings.EqualFold(pw, username) {
		return ErrPasswordIsUsername
	}
	if isCommon(pw) {
		return ErrPasswordCommon
	}
	return nil
}

//go:embed common.txt
var commonRaw []byte

var (
	commonOnce sync.Once
	commonSet  map[string]struct{}
)

// commonPasswords returns the embedded set of common passwords. Lines starting
// with '#' (the attribution header) and blank lines are skipped.
func commonPasswords() map[string]struct{} {
	commonOnce.Do(func() {
		commonSet = make(map[string]struct{}, 10100)
		sc := bufio.NewScanner(bytes.NewReader(commonRaw))
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			commonSet[strings.ToLower(line)] = struct{}{}
		}
	})
	return commonSet
}

// minCommonBase is the shortest listed word that still marks a password as
// common once its trailing digits are stripped.
const minCommonBase = 6

// isCommon reports whether pw is a common password. The comparison is
// case-insensitive. In addition, a password is common when stripping its
// trailing digits leaves a listed word of at least minCommonBase characters,
// so "password1234" is rejected through "password" even though only
// "password" itself is in the list.
func isCommon(pw string) bool {
	set := commonPasswords()
	lower := strings.ToLower(pw)
	if _, ok := set[lower]; ok {
		return true
	}
	base := strings.TrimRight(lower, "0123456789")
	if base == lower || len(base) < minCommonBase {
		return false
	}
	_, ok := set[base]
	return ok
}
