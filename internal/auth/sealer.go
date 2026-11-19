package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

const sealerInfo = "totp-v1"

// Sealer encrypts small secrets (TOTP seeds) with AES-256-GCM. The AES key is
// derived from the configured secret with HKDF-SHA256 (info "totp-v1"). A
// sealed value is nonce (12 bytes) || ciphertext || tag.
type Sealer struct {
	aead cipher.AEAD
}

// NewSealer derives the encryption key from key, which must be at least 32 bytes.
func NewSealer(key []byte) (*Sealer, error) {
	if len(key) < 32 {
		return nil, errors.New("auth: sealer key must be at least 32 bytes")
	}
	derived := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, key, nil, []byte(sealerInfo)), derived); err != nil {
		return nil, fmt.Errorf("auth: derive sealer key: %w", err)
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Sealer{aead: aead}, nil
}

// Seal encrypts plain under a fresh random nonce.
func (s *Sealer) Seal(plain []byte) ([]byte, error) {
	return s.SealWithAAD(plain, nil)
}

// SealWithAAD binds ciphertext to a caller-specific purpose.
func (s *Sealer) SealWithAAD(plain, aad []byte) ([]byte, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("auth: read nonce: %w", err)
	}
	return s.aead.Seal(nonce, nonce, plain, aad), nil
}

// Open decrypts a value produced by Seal and fails if it was altered or sealed
// under a different key.
func (s *Sealer) Open(sealed []byte) ([]byte, error) {
	return s.OpenWithAAD(sealed, nil)
}

// OpenWithAAD decrypts only data sealed for the same purpose.
func (s *Sealer) OpenWithAAD(sealed, aad []byte) ([]byte, error) {
	n := s.aead.NonceSize()
	if len(sealed) < n+s.aead.Overhead() {
		return nil, errors.New("auth: sealed value too short")
	}
	plain, err := s.aead.Open(nil, sealed[:n], sealed[n:], aad)
	if err != nil {
		return nil, errors.New("auth: cannot open sealed value")
	}
	return plain, nil
}
