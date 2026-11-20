package devices

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// Audit actions written by Tags.
const (
	ActionTagCreated = "tag.created"
	ActionTagUpdated = "tag.updated"
	ActionTagDeleted = "tag.deleted"
)

const (
	targetTag     = "tag"
	maxTagNameLen = 64         // characters
	maxTagColor   = 0xFFFFFFFF // unsigned 32-bit ARGB
)

// Tag is a device label. Color is ARGB as an unsigned 32-bit value (for
// example 0xFF1E88E5); names are unique case-insensitively.
type Tag struct {
	ID    uuid.UUID
	Name  string
	Color int64
}

// TagPatch is a change to a tag; nil fields are left alone.
type TagPatch struct {
	Name  *string
	Color *int64
}

// Tags manages device tags. Every change is audited in its transaction.
type Tags struct {
	Pool *pgxpool.Pool
}

// List returns tags by name (case-insensitively) and the cursor of the next
// page ("" on the last page). limit defaults to 50 and is capped at 200.
func (t *Tags) List(ctx context.Context, limit int, cursor string, scope ...*uuid.UUID) ([]Tag, string, error) {
	if limit <= 0 {
		limit = defaultLimit
	}
	limit = min(limit, maxLimit)
	p := db.ListTagsParams{RowLimit: int32(limit + 1)}
	if len(scope) > 0 {
		p.ScopeUser = scope[0]
	}
	if cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || len(raw) == 0 || !validText(string(raw), maxTagNameLen) {
			return nil, "", ErrInvalidCursor
		}
		after := string(raw)
		p.AfterName = &after
	}
	rows, err := db.New(t.Pool).ListTags(ctx, p)
	if err != nil {
		return nil, "", fmt.Errorf("devices: list tags: %w", err)
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		next = base64.RawURLEncoding.EncodeToString([]byte(rows[limit-1].Name))
	}
	out := make([]Tag, len(rows))
	for i, r := range rows {
		out[i] = Tag(r)
	}
	return out, next, nil
}

// Create adds a tag. A name in use gives ErrNameTaken; a bad name or color an
// InputError.
func (t *Tags) Create(ctx context.Context, a Actor, name string, color int64) (Tag, error) {
	name, err := checkTag(name, color)
	if err != nil {
		return Tag{}, err
	}
	var tag Tag
	err = store.Tx(ctx, t.Pool, func(q *db.Queries) error {
		row, err := q.CreateTag(ctx, db.CreateTagParams{Name: name, Color: color})
		if err != nil {
			return tagWriteError(err)
		}
		tag = Tag(row)
		return audit.Record(ctx, q, a.event(ActionTagCreated, targetTag, tag.ID.String(),
			map[string]any{"name": tag.Name, "color": tag.Color}))
	})
	return tag, err
}

// Update renames or recolors a tag, auditing the changed fields before and
// after. An unknown tag gives ErrNotFound.
func (t *Tags) Update(ctx context.Context, a Actor, id uuid.UUID, p TagPatch) (Tag, error) {
	var tag Tag
	err := store.Tx(ctx, t.Pool, func(q *db.Queries) error {
		cur, err := q.GetTagForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("devices: get tag %s: %w", id, err)
		}
		next := db.UpdateTagParams{ID: id, Name: cur.Name, Color: cur.Color}
		before, after := map[string]any{}, map[string]any{}
		if p.Name != nil {
			next.Name = *p.Name
			before["name"], after["name"] = cur.Name, *p.Name
		}
		if p.Color != nil {
			next.Color = *p.Color
			before["color"], after["color"] = cur.Color, *p.Color
		}
		if next.Name, err = checkTag(next.Name, next.Color); err != nil {
			return err
		}
		if p.Name != nil {
			after["name"] = next.Name
		}
		row, err := q.UpdateTag(ctx, next)
		if err != nil {
			return tagWriteError(err)
		}
		tag = Tag(row)
		return audit.Record(ctx, q, a.event(ActionTagUpdated, targetTag, id.String(),
			map[string]any{"before": before, "after": after}))
	})
	return tag, err
}

// Delete removes a tag and detaches it from every device. An unknown tag
// gives ErrNotFound.
func (t *Tags) Delete(ctx context.Context, a Actor, id uuid.UUID) error {
	return store.Tx(ctx, t.Pool, func(q *db.Queries) error {
		cur, err := q.GetTagForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("devices: get tag %s: %w", id, err)
		}
		row, err := q.DeleteTag(ctx, id)
		if err != nil {
			return fmt.Errorf("devices: delete tag %s: %w", id, err)
		}
		return audit.Record(ctx, q, a.event(ActionTagDeleted, targetTag, id.String(),
			map[string]any{"name": cur.Name, "devices": row.Devices}))
	})
}

// checkTag validates a tag and returns its trimmed name.
func checkTag(name string, color int64) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || !printable(name, maxTagNameLen) {
		return "", InputError(fmt.Sprintf("name must be 1 to %d printable characters", maxTagNameLen))
	}
	if color < 0 || color > maxTagColor {
		return "", InputError("color must be an ARGB value from 0 to 4294967295")
	}
	return name, nil
}

func tagWriteError(err error) error {
	if isUniqueViolation(err) {
		return ErrNameTaken
	}
	return fmt.Errorf("devices: write tag: %w", err)
}
