// Package keysetcursor encodes the timestamp and UUID shared by keyset pages.
package keysetcursor

import (
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ErrInvalid is returned when a cursor is not a timestamp and UUID pair.
var ErrInvalid = errors.New("invalid cursor")

// Encode returns base64url of "<unix microseconds>.<uuid>".
func Encode(at time.Time, id uuid.UUID) string {
	raw := strconv.FormatInt(at.UnixMicro(), 10) + "." + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// Decode parses a cursor created by Encode.
func Decode(s string) (time.Time, uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, uuid.Nil, ErrInvalid
	}
	micro, idStr, ok := strings.Cut(string(raw), ".")
	if !ok {
		return time.Time{}, uuid.Nil, ErrInvalid
	}
	us, err := strconv.ParseInt(micro, 10, 64)
	if err != nil {
		return time.Time{}, uuid.Nil, ErrInvalid
	}
	id, err := uuid.Parse(idStr)
	if err != nil {
		return time.Time{}, uuid.Nil, ErrInvalid
	}
	return time.UnixMicro(us).UTC(), id, nil
}
