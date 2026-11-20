// Package audit writes and reads the append-only audit_events table.
//
// Record takes a *db.Queries so a caller can pass the one from store.Tx and
// have the event commit or roll back together with the change it describes.
package audit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"time"

	"github.com/google/uuid"

	"github.com/dottio123/ferricade/internal/keysetcursor"
	"github.com/dottio123/ferricade/internal/store/db"
)

const (
	defaultLimit = 50
	maxLimit     = 200
)

// ErrInvalidCursor is returned by List for a cursor it did not issue.
var ErrInvalidCursor = errors.New("audit: invalid cursor")

// Event is one thing that happened. ActorUserID is nil for unauthenticated or
// system actors; ActorIP is required.
type Event struct {
	ActorUserID *uuid.UUID
	ActorIP     netip.Addr
	Action      string
	TargetType  string
	TargetID    string
	Details     map[string]any
}

// Record appends e to the audit log. A nil Details is stored as {}.
func Record(ctx context.Context, q *db.Queries, e Event) error {
	if !e.ActorIP.IsValid() {
		return errors.New("audit: event has no valid actor IP")
	}
	details := []byte("{}")
	if e.Details != nil {
		var err error
		if details, err = json.Marshal(e.Details); err != nil {
			return fmt.Errorf("audit: encode details: %w", err)
		}
	}
	if err := q.InsertAuditEvent(ctx, db.InsertAuditEventParams{
		ActorUserID: e.ActorUserID,
		ActorIP:     e.ActorIP,
		Action:      e.Action,
		TargetType:  e.TargetType,
		TargetID:    e.TargetID,
		Details:     details,
	}); err != nil {
		return fmt.Errorf("audit: record %q: %w", e.Action, err)
	}
	return nil
}

// Filter narrows List. Zero values mean "no filter". Since is inclusive and
// Until exclusive. Limit defaults to 50 and is capped at 200. Cursor is the
// value List returned with the previous page.
type Filter struct {
	Action      string
	TargetID    string
	ActorUserID *uuid.UUID
	// OwnKindsOnly limits the list to auth.* entries and connect links: all a
	// User may read of their own history.
	OwnKindsOnly bool
	Since, Until time.Time
	Limit        int
	Cursor       string
}

// Entry is a stored event. Details is never nil.
type Entry struct {
	ID          uuid.UUID
	At          time.Time
	ActorUserID *uuid.UUID
	ActorIP     netip.Addr
	Action      string
	TargetType  string
	TargetID    string
	Details     map[string]any
}

// List returns entries newest first and the cursor for the next page, which is
// empty when there are no more entries.
func List(ctx context.Context, q *db.Queries, f Filter) ([]Entry, string, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	limit = min(limit, maxLimit)

	p := db.ListAuditEventsParams{
		ActorUserID:  f.ActorUserID,
		OwnKindsOnly: f.OwnKindsOnly,
		// One extra row tells us whether another page exists.
		RowLimit: int32(limit + 1),
	}
	if f.Action != "" {
		p.Action = &f.Action
	}
	if f.TargetID != "" {
		p.TargetID = &f.TargetID
	}
	if !f.Since.IsZero() {
		p.Since = &f.Since
	}
	if !f.Until.IsZero() {
		p.Until = &f.Until
	}
	if f.Cursor != "" {
		at, id, err := decodeCursor(f.Cursor)
		if err != nil {
			return nil, "", err
		}
		p.CursorAt, p.CursorID = &at, &id
	}

	rows, err := q.ListAuditEvents(ctx, p)
	if err != nil {
		return nil, "", fmt.Errorf("audit: list: %w", err)
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[limit-1]
		next = encodeCursor(last.At, last.ID)
	}

	entries := make([]Entry, len(rows))
	for i, r := range rows {
		details := map[string]any{}
		if err := json.Unmarshal(r.Details, &details); err != nil {
			return nil, "", fmt.Errorf("audit: decode details of %s: %w", r.ID, err)
		}
		if details == nil { // stored JSON null
			details = map[string]any{}
		}
		entries[i] = Entry{
			ID: r.ID, At: r.At.UTC(), ActorUserID: r.ActorUserID, ActorIP: r.ActorIP,
			Action: r.Action, TargetType: r.TargetType, TargetID: r.TargetID, Details: details,
		}
	}
	return entries, next, nil
}

// The cursor is base64url of "<unix microseconds>.<uuid>". Postgres stores
// timestamps at microsecond precision, so this round-trips exactly.
func encodeCursor(at time.Time, id uuid.UUID) string {
	return keysetcursor.Encode(at, id)
}

func decodeCursor(s string) (time.Time, uuid.UUID, error) {
	at, id, err := keysetcursor.Decode(s)
	if err != nil {
		return time.Time{}, uuid.Nil, ErrInvalidCursor
	}
	return at, id, nil
}
