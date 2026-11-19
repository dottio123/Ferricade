package auth

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/require"
)

func testKey(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

func TestSealerRoundTrip(t *testing.T) {
	s, err := NewSealer(testKey(1))
	require.NoError(t, err)
	plain := []byte("JBSWY3DPEHPK3PXP")

	a, err := s.Seal(plain)
	require.NoError(t, err)
	b, err := s.Seal(plain)
	require.NoError(t, err)
	require.NotEqual(t, a, b)
	require.NotContains(t, string(a), string(plain))

	got, err := s.Open(a)
	require.NoError(t, err)
	require.Equal(t, plain, got)

	// Tampered ciphertext.
	bad := append([]byte(nil), a...)
	bad[len(bad)-1] ^= 1
	_, err = s.Open(bad)
	require.Error(t, err)

	// Tampered nonce.
	bad = append([]byte(nil), a...)
	bad[0] ^= 1
	_, err = s.Open(bad)
	require.Error(t, err)

	// Different key.
	other, err := NewSealer(testKey(2))
	require.NoError(t, err)
	_, err = other.Open(a)
	require.Error(t, err)

	// Too short.
	_, err = s.Open([]byte("short"))
	require.Error(t, err)
}

func TestSealerEmptyPlaintext(t *testing.T) {
	s, err := NewSealer(testKey(1))
	require.NoError(t, err)
	sealed, err := s.Seal(nil)
	require.NoError(t, err)
	got, err := s.Open(sealed)
	require.NoError(t, err)
	require.Empty(t, got)
}

func TestNewSealerKeyLength(t *testing.T) {
	_, err := NewSealer(make([]byte, 31))
	require.Error(t, err)
	_, err = NewSealer(nil)
	require.Error(t, err)
	_, err = NewSealer(make([]byte, 48))
	require.NoError(t, err)
}

func TestSealerAADSeparatesFlowCookie(t *testing.T) {
	s, err := NewSealer(testKey(1))
	require.NoError(t, err)
	flow, err := s.SealWithAAD([]byte("flow"), []byte("ferricade/oidc-flow/v1"))
	require.NoError(t, err)
	_, err = s.Open(flow)
	require.Error(t, err)
	_, err = s.OpenWithAAD(flow, []byte("wrong"))
	require.Error(t, err)
	got, err := s.OpenWithAAD(flow, []byte("ferricade/oidc-flow/v1"))
	require.NoError(t, err)
	require.Equal(t, []byte("flow"), got)
	legacy, err := s.Seal([]byte("legacy"))
	require.NoError(t, err)
	_, err = s.OpenWithAAD(legacy, []byte("ferricade/oidc-flow/v1"))
	require.Error(t, err)
	got, err = s.Open(legacy)
	require.NoError(t, err)
	require.Equal(t, []byte("legacy"), got)
}
