package devices

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"

	"github.com/google/uuid"
)

// Bind the cursor to the effective filters, including the visibility scope,
// while allowing clients to change the page size.
func filterHash(f Filter) [32]byte {
	f.Limit, f.Cursor, f.Sort, f.Order = 0, "", "", ""
	raw, _ := json.Marshal(f)
	return sha256.Sum256(raw)
}

type deviceCursor struct {
	ID      uuid.UUID `json:"id"`
	Sort    string    `json:"sort"`
	Order   string    `json:"order"`
	Filters [32]byte  `json:"filters"`
}

func encodeDeviceCursor(id uuid.UUID, f Filter) string {
	raw, _ := json.Marshal(deviceCursor{id, f.Sort, f.Order, filterHash(f)})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeDeviceCursor(value string, f Filter) (uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	var c deviceCursor
	if err != nil || json.Unmarshal(raw, &c) != nil || c.ID == uuid.Nil {
		return uuid.Nil, ErrInvalidCursor
	}
	if c.Sort != f.Sort || c.Order != f.Order {
		return uuid.Nil, InputError("cursor does not match sort")
	}
	if c.Filters != filterHash(f) {
		return uuid.Nil, InputError("cursor does not match filters")
	}
	return c.ID, nil
}
