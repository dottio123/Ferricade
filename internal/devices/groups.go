package devices

import (
	"context"
	"encoding/json"
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

type GroupConflictResult struct {
	Updated  []uuid.UUID
	Resolved []uuid.UUID
}

// ReevaluateGroupConflicts removes a group from matching open alerts unless
// keepGroup reports that the group's remaining rules still match the device.
func ReevaluateGroupConflicts(ctx context.Context, q *db.Queries, groupID uuid.UUID, actorID *uuid.UUID, keepGroup func(string) bool) (GroupConflictResult, error) {
	result := GroupConflictResult{Updated: []uuid.UUID{}, Resolved: []uuid.UUID{}}
	rows, err := q.LockGroupConflictAlerts(ctx, groupID.String())
	if err != nil {
		return result, fmt.Errorf("devices: lock group conflict alerts: %w", err)
	}
	for _, row := range rows {
		if keepGroup != nil && keepGroup(row.Hostname) {
			continue
		}
		var details map[string]json.RawMessage
		if err := json.Unmarshal(row.Details, &details); err != nil {
			return result, fmt.Errorf("devices: decode alert %s: %w", row.AlertID, err)
		}
		var ids []string
		if err := json.Unmarshal(details["group_ids"], &ids); err != nil {
			return result, fmt.Errorf("devices: decode alert groups %s: %w", row.AlertID, err)
		}
		remaining := make([]string, 0, len(ids))
		for _, id := range ids {
			if id != groupID.String() {
				remaining = append(remaining, id)
			}
		}
		raw, err := json.Marshal(remaining)
		if err != nil {
			return result, fmt.Errorf("devices: encode alert groups %s: %w", row.AlertID, err)
		}
		if len(remaining) < 2 {
			if _, err := q.ResolveGroupConflictAlert(ctx, db.ResolveGroupConflictAlertParams{ID: row.AlertID, ResolvedBy: actorID}); err != nil {
				return result, fmt.Errorf("devices: resolve alert %s: %w", row.AlertID, err)
			}
			result.Resolved = append(result.Resolved, row.DeviceID)
		} else {
			details["group_ids"] = raw
			updated, err := json.Marshal(details)
			if err != nil {
				return result, fmt.Errorf("devices: encode alert %s: %w", row.AlertID, err)
			}
			if err := q.UpdateGroupConflictDetails(ctx, db.UpdateGroupConflictDetailsParams{ID: row.AlertID, Details: updated}); err != nil {
				return result, fmt.Errorf("devices: update alert %s: %w", row.AlertID, err)
			}
			result.Updated = append(result.Updated, row.DeviceID)
		}
	}
	return result, nil
}

// Audit actions written by Groups.
const (
	ActionGroupCreated = "group.created"
	ActionGroupRenamed = "group.renamed"
	ActionGroupMoved   = "group.moved"
	ActionGroupDeleted = "group.deleted"
)

const (
	targetGroup     = "group"
	maxGroupNameLen = 128 // characters
)

// Group is a device group. Tree fills Children (by name); the other methods
// leave it empty.
type Group struct {
	ID       uuid.UUID
	ParentID *uuid.UUID
	PolicyID *uuid.UUID
	Name     string
	Children []Group
}

type treeGroupRow struct {
	ID       uuid.UUID
	ParentID *uuid.UUID
	Name     string
	PolicyID *uuid.UUID
}

func groupFromRow(r db.DeviceGroup) Group {
	return Group{ID: r.ID, ParentID: r.ParentID, PolicyID: r.PolicyID, Name: r.Name, Children: []Group{}}
}

// Groups manages the device group tree. Names are unique among siblings.
// Every change is audited in its transaction; creates, moves and deletes
// also take a tree-wide lock, so concurrent moves cannot form a cycle.
type Groups struct {
	Pool *pgxpool.Pool
}

// Tree returns the root groups, each with its descendants, siblings ordered
// by name.
func (g *Groups) Tree(ctx context.Context, scope ...*uuid.UUID) ([]Group, error) {
	q := db.New(g.Pool)
	var rows []treeGroupRow
	var err error
	if len(scope) > 0 && scope[0] != nil {
		visible, queryErr := q.ListVisibleGroups(ctx, *scope[0])
		err = queryErr
		for _, r := range visible {
			rows = append(rows, treeGroupRow{ID: r.ID, ParentID: r.ParentID, Name: r.Name, PolicyID: r.PolicyID})
		}
	} else {
		groups, queryErr := q.ListGroups(ctx)
		err = queryErr
		for _, r := range groups {
			rows = append(rows, treeGroupRow{ID: r.ID, ParentID: r.ParentID, Name: r.Name, PolicyID: r.PolicyID})
		}
	}
	if err != nil {
		return nil, fmt.Errorf("devices: list groups: %w", err)
	}
	children := map[uuid.UUID][]treeGroupRow{}
	var roots []treeGroupRow
	for _, r := range rows { // rows are ordered by name
		if r.ParentID == nil {
			roots = append(roots, r)
		} else {
			children[*r.ParentID] = append(children[*r.ParentID], r)
		}
	}
	// seen guards against a cycle in the stored data, which the
	// application never creates.
	seen := map[uuid.UUID]bool{}
	var build func(rs []treeGroupRow) []Group
	build = func(rs []treeGroupRow) []Group {
		out := []Group{}
		for _, r := range rs {
			if seen[r.ID] {
				continue
			}
			seen[r.ID] = true
			n := Group{ID: r.ID, ParentID: r.ParentID, PolicyID: r.PolicyID, Name: r.Name, Children: build(children[r.ID])}
			out = append(out, n)
		}
		return out
	}
	return build(roots), nil
}

// Create adds a group under parent (nil for a root group). A sibling with
// the same name gives ErrNameTaken; a bad name or unknown parent an
// InputError.
func (g *Groups) Create(ctx context.Context, a Actor, name string, parent *uuid.UUID) (Group, error) {
	name, err := checkGroupName(name)
	if err != nil {
		return Group{}, err
	}
	var grp Group
	err = store.Tx(ctx, g.Pool, func(q *db.Queries) error {
		if err := q.LockGroupTree(ctx); err != nil {
			return fmt.Errorf("devices: lock group tree: %w", err)
		}
		row, err := q.CreateGroup(ctx, db.CreateGroupParams{ParentID: parent, Name: name})
		if err != nil {
			return groupWriteError(err)
		}
		grp = groupFromRow(row)
		return audit.Record(ctx, q, a.event(ActionGroupCreated, targetGroup, grp.ID.String(),
			map[string]any{"name": name, "parent_id": uuidOrNil(parent)}))
	})
	return grp, err
}

// Rename changes a group's name. An unknown group gives ErrNotFound, a
// sibling with the name ErrNameTaken.
func (g *Groups) Rename(ctx context.Context, a Actor, id uuid.UUID, name string) (Group, error) {
	name, err := checkGroupName(name)
	if err != nil {
		return Group{}, err
	}
	var grp Group
	err = store.Tx(ctx, g.Pool, func(q *db.Queries) error {
		cur, err := lockGroup(ctx, q, id)
		if err != nil {
			return err
		}
		row, err := q.RenameGroup(ctx, db.RenameGroupParams{ID: id, Name: name})
		if err != nil {
			return groupWriteError(err)
		}
		grp = groupFromRow(row)
		return audit.Record(ctx, q, a.event(ActionGroupRenamed, targetGroup, id.String(),
			map[string]any{"before": cur.Name, "after": name}))
	})
	return grp, err
}

// Move puts a group under parent (nil makes it a root). Moving a group under
// itself or one of its descendants gives ErrCycle; this is checked by
// walking up the tree from parent. An unknown group gives ErrNotFound, an
// unknown parent an InputError, a sibling with the same name ErrNameTaken.
func (g *Groups) Move(ctx context.Context, a Actor, id uuid.UUID, parent *uuid.UUID) (Group, error) {
	var grp Group
	err := store.Tx(ctx, g.Pool, func(q *db.Queries) error {
		if err := q.LockGroupTree(ctx); err != nil {
			return fmt.Errorf("devices: lock group tree: %w", err)
		}
		cur, err := lockGroup(ctx, q, id)
		if err != nil {
			return err
		}
		if parent != nil {
			cycle, err := q.GroupIsSelfOrAncestor(ctx, db.GroupIsSelfOrAncestorParams{Start: *parent, Target: id})
			if err != nil {
				return fmt.Errorf("devices: check group cycle: %w", err)
			}
			if cycle {
				return ErrCycle
			}
		}
		row, err := q.MoveGroup(ctx, db.MoveGroupParams{ID: id, ParentID: parent})
		if err != nil {
			return groupWriteError(err)
		}
		grp = groupFromRow(row)
		return audit.Record(ctx, q, a.event(ActionGroupMoved, targetGroup, id.String(),
			map[string]any{"before": uuidOrNil(cur.ParentID), "after": uuidOrNil(parent)}))
	})
	return grp, err
}

// Delete removes a group that has no child groups and no devices, else
// ErrNotEmpty. An unknown group gives ErrNotFound.
func (g *Groups) Delete(ctx context.Context, a Actor, id uuid.UUID) error {
	return store.Tx(ctx, g.Pool, func(q *db.Queries) error {
		if err := q.LockGroupTree(ctx); err != nil {
			return fmt.Errorf("devices: lock group tree: %w", err)
		}
		cur, err := lockGroup(ctx, q, id)
		if err != nil {
			return err
		}
		inUse, err := q.GroupInUse(ctx, id)
		if err != nil {
			return fmt.Errorf("devices: check group %s: %w", id, err)
		}
		if inUse {
			return ErrNotEmpty
		}
		conflicts, err := ReevaluateGroupConflicts(ctx, q, id, &a.UserID, nil)
		if err != nil {
			return err
		}
		if err := q.DeleteGroup(ctx, id); err != nil {
			if isFKViolation(err) { // a device joined it concurrently
				return ErrNotEmpty
			}
			return fmt.Errorf("devices: delete group %s: %w", id, err)
		}
		details := map[string]any{"name": cur.Name, "parent_id": uuidOrNil(cur.ParentID)}
		if len(conflicts.Updated) != 0 {
			details["conflicts_updated"] = conflicts.Updated
		}
		if len(conflicts.Resolved) != 0 {
			details["conflicts_resolved"] = conflicts.Resolved
		}
		return audit.Record(ctx, q, a.event(ActionGroupDeleted, targetGroup, id.String(), details))
	})
}

func lockGroup(ctx context.Context, q *db.Queries, id uuid.UUID) (db.DeviceGroup, error) {
	g, err := q.GetGroupForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return g, ErrNotFound
	}
	if err != nil {
		return g, fmt.Errorf("devices: get group %s: %w", id, err)
	}
	return g, nil
}

func checkGroupName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || !printable(name, maxGroupNameLen) {
		return "", InputError(fmt.Sprintf("name must be 1 to %d printable characters", maxGroupNameLen))
	}
	return name, nil
}

func groupWriteError(err error) error {
	switch {
	case isUniqueViolation(err):
		return ErrNameTaken
	case isFKViolation(err):
		return InputError("parent_id does not name a group")
	default:
		return fmt.Errorf("devices: write group: %w", err)
	}
}
