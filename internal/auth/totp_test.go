package auth

import (
	"encoding/base32"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

var rfcSecret = base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte("12345678901234567890"))

func TestTOTPRFC6238Vectors(t *testing.T) {
	// SHA-1 vectors from RFC 6238 Appendix B, truncated to 6 digits.
	for _, c := range []struct {
		unix int64
		code string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1234567890, "005924"},
	} {
		step, ok := VerifyTOTP(rfcSecret, c.code, time.Unix(c.unix, 0), 0)
		require.True(t, ok, c.code)
		require.Equal(t, c.unix/30, step)
	}
}

func TestVerifyTOTPWindow(t *testing.T) {
	const s = int64(1111111109 / 30)
	code := "081804"
	for _, d := range []int64{-1, 0, 1} {
		now := time.Unix((s+d)*30+5, 0)
		step, ok := VerifyTOTP(rfcSecret, code, now, 0)
		require.True(t, ok, "offset %d", d)
		require.Equal(t, s, step)
	}
	for _, d := range []int64{-2, 2} {
		step, ok := VerifyTOTP(rfcSecret, code, time.Unix((s+d)*30+5, 0), 0)
		require.False(t, ok, "offset %d", d)
		require.Zero(t, step)
	}
}

func TestVerifyTOTPRejectsReplay(t *testing.T) {
	now := time.Unix(1111111109, 0)
	step, ok := VerifyTOTP(rfcSecret, "081804", now, 0)
	require.True(t, ok)
	require.Equal(t, int64(1111111109/30), step)

	last := step
	step, ok = VerifyTOTP(rfcSecret, "081804", now, last)
	require.False(t, ok)
	require.Zero(t, step)

	// A code for an earlier step than lastStep is also rejected.
	_, ok = VerifyTOTP(rfcSecret, "081804", now, last+5)
	require.False(t, ok)
}

func TestVerifyTOTPBadInput(t *testing.T) {
	now := time.Unix(59, 0)
	for _, code := range []string{"", "28708", "2870822", "28708a", " 287082"} {
		_, ok := VerifyTOTP(rfcSecret, code, now, 0)
		require.False(t, ok, code)
	}
	_, ok := VerifyTOTP("not base32!!", "287082", now, 0)
	require.False(t, ok)
	_, ok = VerifyTOTP("", "287082", now, 0)
	require.False(t, ok)
	_, ok = VerifyTOTP(rfcSecret, "000000", now, 0)
	require.False(t, ok)
}

func TestNewTOTPSecret(t *testing.T) {
	s, err := NewTOTPSecret()
	require.NoError(t, err)
	require.Len(t, s, 32) // 20 bytes, unpadded base32
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(s)
	require.NoError(t, err)
	require.Len(t, raw, 20)
	s2, err := NewTOTPSecret()
	require.NoError(t, err)
	require.NotEqual(t, s, s2)
}

func TestTOTPURL(t *testing.T) {
	got := TOTPURL("alice", "ABCDEF")
	require.Equal(t, "otpauth://totp/ferricade:alice?secret=ABCDEF&issuer=ferricade&algorithm=SHA1&digits=6&period=30", got)

	u, err := url.Parse(TOTPURL("a b@x.io", "ABCDEF"))
	require.NoError(t, err)
	require.Equal(t, "/ferricade:a b@x.io", u.Path)
	require.Equal(t, "ferricade", u.Query().Get("issuer"))
}

func TestTOTPCodeMatchesVerify(t *testing.T) {
	secret, err := NewTOTPSecret()
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	code, err := TOTPCode(secret, at)
	if err != nil {
		t.Fatal(err)
	}
	if step, ok := VerifyTOTP(secret, code, at, 0); !ok || step != at.Unix()/30 {
		t.Fatalf("VerifyTOTP(%q) = %d, %v", code, step, ok)
	}
	if _, err := TOTPCode("not base32!", at); err == nil {
		t.Fatal("want error for a bad secret")
	}
}
