package auth

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestHashVerifyPassword(t *testing.T) {
	enc, err := HashPassword(context.Background(), "correct horse battery", TestParams)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(enc, "$argon2id$v=19$m=64,t=1,p=1$"), enc)

	ok, err := VerifyPassword(context.Background(), enc, "correct horse battery")
	require.NoError(t, err)
	require.True(t, ok)

	ok, err = VerifyPassword(context.Background(), enc, "wrong horse battery")
	require.NoError(t, err)
	require.False(t, ok)
}

func TestVerifyPasswordUsesEncodedParams(t *testing.T) {
	// Hashed with TestParams; verification must read m/t/p from the string
	// rather than use DefaultParams.
	require.NotEqual(t, DefaultParams.Memory, TestParams.Memory)
	enc, err := HashPassword(context.Background(), "pw", TestParams)
	require.NoError(t, err)
	ok, err := VerifyPassword(context.Background(), enc, "pw")
	require.NoError(t, err)
	require.True(t, ok)
}

func TestHashPasswordSaltsDiffer(t *testing.T) {
	a, err := HashPassword(context.Background(), "pw", TestParams)
	require.NoError(t, err)
	b, err := HashPassword(context.Background(), "pw", TestParams)
	require.NoError(t, err)
	require.NotEqual(t, a, b)
}

func TestDefaultParams(t *testing.T) {
	require.Equal(t, Params{Memory: 65536, Iterations: 3, Parallelism: 2, SaltLen: 16, KeyLen: 32}, DefaultParams)
	require.Equal(t, uint32(64), TestParams.Memory)
	require.Equal(t, uint32(1), TestParams.Iterations)
	require.Equal(t, uint8(1), TestParams.Parallelism)
}

func TestVerifyPasswordRejectsBadEncoding(t *testing.T) {
	const salt = "c2FsdHNhbHRzYWx0"                 // 12 bytes
	const hash = "aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo" // 24 bytes
	enc := func(v, params, s, h string) string { return "$argon2id$" + v + "$" + params + "$" + s + "$" + h }
	ok := "m=64,t=1,p=1"

	// Sanity: the template with valid values parses (wrong password, no error).
	good, err := VerifyPassword(context.Background(), enc("v=19", ok, salt, hash), "pw")
	require.NoError(t, err)
	require.False(t, good)

	for name, e := range map[string]string{
		"empty":           "",
		"plain":           "plain",
		"wrong algorithm": "$argon2i$v=19$" + ok + "$" + salt + "$" + hash,
		"wrong version":   enc("v=18", ok, salt, hash),
		"version junk":    enc("v=19x", ok, salt, hash),
		"version spaced":  enc("v= 19", ok, salt, hash),
		"extra field":     enc("v=19", ok, salt, hash) + "$x",
		"missing hash":    "$argon2id$v=19$" + ok + "$" + salt,
		"m not number":    enc("v=19", "m=x,t=1,p=1", salt, hash),
		"m space":         enc("v=19", "m= 64,t=1,p=1", salt, hash),
		"m leading zero":  enc("v=19", "m=064,t=1,p=1", salt, hash),
		"m plus sign":     enc("v=19", "m=+64,t=1,p=1", salt, hash),
		"p trailing junk": enc("v=19", "m=64,t=1,p=1junk", salt, hash),
		"t leading zero":  enc("v=19", "m=64,t=01,p=1", salt, hash),
		"extra param":     enc("v=19", "m=64,t=1,p=1,x=1", salt, hash),
		"missing param":   enc("v=19", "m=64,t=1", salt, hash),
		"wrong order":     enc("v=19", "t=1,m=64,p=1", salt, hash),
		"m overflows u32": enc("v=19", "m=4294967296,t=1,p=1", salt, hash),
		"p overflows u8":  enc("v=19", "m=64,t=1,p=256", salt, hash),
		"salt not base64": enc("v=19", ok, "!!!!", hash),
		"salt padded":     enc("v=19", ok, "c2FsdHNhbHRzYWx0AA==", hash),
		"salt non-canon":  enc("v=19", ok, "AAAAAAAAAAB", hash), // 8 bytes, trailing bits set
		"hash empty":      enc("v=19", ok, salt, ""),
		"m zero":          enc("v=19", "m=0,t=1,p=1", salt, hash),
		"t zero":          enc("v=19", "m=64,t=0,p=1", salt, hash),
		"p zero":          enc("v=19", "m=64,t=1,p=0", salt, hash),
		"m too small":     enc("v=19", "m=7,t=1,p=1", salt, hash),
		"m huge (OOM)":    enc("v=19", "m=4294967295,t=1,p=1", salt, hash),
		"m just over cap": enc("v=19", "m=1048577,t=1,p=1", salt, hash),
		"t huge (hang)":   enc("v=19", "m=64,t=4294967295,p=1", salt, hash),
		"t just over cap": enc("v=19", "m=64,t=11,p=1", salt, hash),
		"p huge":          enc("v=19", "m=64,t=1,p=255", salt, hash),
		"p just over cap": enc("v=19", "m=64,t=1,p=17", salt, hash),
		"salt 1 byte":     enc("v=19", ok, "AA", hash),
		"salt 7 bytes":    enc("v=19", ok, b64.EncodeToString(make([]byte, 7)), hash),
		"salt 65 bytes":   enc("v=19", ok, b64.EncodeToString(make([]byte, 65)), hash),
		"hash 1 byte":     enc("v=19", ok, salt, "AA"),
		"hash 15 bytes":   enc("v=19", ok, salt, b64.EncodeToString(make([]byte, 15))),
		"hash 65 bytes":   enc("v=19", ok, salt, b64.EncodeToString(make([]byte, 65))),
	} {
		start := time.Now()
		got, err := VerifyPassword(context.Background(), e, "pw")
		require.Error(t, err, name)
		require.False(t, got, name)
		require.Less(t, time.Since(start), 500*time.Millisecond, name+": must fail before hashing")
	}
}

func TestVerifyPasswordBoundaryParamsAccepted(t *testing.T) {
	// Values exactly at the bounds are accepted by the parser (hash differs, so
	// the result is false without error). Kept cheap: only the low bounds run.
	salt := b64.EncodeToString(make([]byte, 8))
	hash := b64.EncodeToString(make([]byte, 16))
	got, err := VerifyPassword(context.Background(), "$argon2id$v=19$m=8,t=1,p=1$"+salt+"$"+hash, "pw")
	require.NoError(t, err)
	require.False(t, got)
}

func TestHashPasswordRejectsOutOfBoundsParams(t *testing.T) {
	for name, p := range map[string]Params{
		"zero":         {},
		"memory huge":  {Memory: 1 << 21, Iterations: 1, Parallelism: 1, SaltLen: 16, KeyLen: 32},
		"salt short":   {Memory: 64, Iterations: 1, Parallelism: 1, SaltLen: 4, KeyLen: 32},
		"key short":    {Memory: 64, Iterations: 1, Parallelism: 1, SaltLen: 16, KeyLen: 8},
		"too many its": {Memory: 64, Iterations: 11, Parallelism: 1, SaltLen: 16, KeyLen: 32},
	} {
		_, err := HashPassword(context.Background(), "pw", p)
		require.Error(t, err, name)
	}
	// Production and test params are within bounds.
	for _, p := range []Params{DefaultParams, TestParams} {
		_, err := HashPassword(context.Background(), "pw", p)
		require.NoError(t, err)
	}
}

func TestValidatePassword(t *testing.T) {
	require.ErrorIs(t, ValidatePassword("alice", "short"), ErrPasswordTooShort)
	require.ErrorIs(t, ValidatePassword("alice", "password1234"), ErrPasswordCommon)
	require.ErrorIs(t, ValidatePassword("alice-is-long", "alice-is-long"), ErrPasswordIsUsername)
	require.NoError(t, ValidatePassword("alice", "correct horse battery"))
}

func TestValidatePasswordCommonRules(t *testing.T) {
	// Case-insensitive match against the list.
	require.ErrorIs(t, ValidatePassword("alice", "Password1234"), ErrPasswordCommon)
	// Trailing digits stripped yields a listed word of length >= 6.
	require.ErrorIs(t, ValidatePassword("alice", "qwerty987654321"), ErrPasswordCommon)
	// Username comparison is case-insensitive.
	require.ErrorIs(t, ValidatePassword("Alice-Is-Long", "alice-is-long"), ErrPasswordIsUsername)
	// Length counts characters, not bytes.
	require.ErrorIs(t, ValidatePassword("alice", "ééééé"), ErrPasswordTooShort)
}

func TestCommonListLoaded(t *testing.T) {
	require.Greater(t, len(commonPasswords()), 9000)
	_, header := commonPasswords()["# source"]
	require.False(t, header)
}

func TestValidateUsername(t *testing.T) {
	for _, ok := range []string{"a", "alice", "alice.smith", "a_b-c@example.com", strings.Repeat("x", 64)} {
		if err := ValidateUsername(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", " alice", "has space", strings.Repeat("x", 65), "ünï", "a\x00b", "a/b"} {
		if err := ValidateUsername(bad); err != ErrInvalidUsername {
			t.Errorf("%q: got %v", bad, err)
		}
	}
}
