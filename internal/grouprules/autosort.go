package grouprules

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

const ActionAutoSorted = "devices.auto_sorted"

var ErrAutoSortBusy = errors.New("auto sort could not start: devices are busy, try again")

type Move struct {
	Device RuleDeviceRef     `json:"device"`
	From   *devices.GroupRef `json:"from_group"`
	To     devices.GroupRef  `json:"to_group"`
}

type AutoSortResult struct {
	Moves     []Move     `json:"moves"`
	Conflicts []Conflict `json:"conflicts"`
	Unchanged int        `json:"unchanged"`
}

func (s *Service) AutoSortPreview(ctx context.Context) (AutoSortResult, error) {
	var out AutoSortResult
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		rows, err := q.AutoSortDevices(ctx)
		if err != nil {
			return fmt.Errorf("grouprules: preview approved devices: %w", err)
		}
		devs := make([]RuleDeviceRef, len(rows))
		for i, r := range rows {
			devs[i] = RuleDeviceRef{ID: r.ID, RustdeskID: r.RustdeskID, Hostname: r.Hostname, Alias: r.Alias, State: r.State, GroupID: r.GroupID}
		}
		out, err = computeAutoSort(ctx, q, devs)
		return err
	})
	return out, err
}

func (s *Service) AutoSort(ctx context.Context, a devices.Actor) (AutoSortResult, error) {
	var out AutoSortResult
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		if err := q.SetAutoSortLockTimeout(ctx); err != nil {
			return fmt.Errorf("grouprules: set lock timeout: %w", err)
		}
		if err := q.LockAutoSort(ctx); err != nil {
			return fmt.Errorf("grouprules: lock auto sort: %w", err)
		}
		if err := q.LockAutoSortDeviceChanges(ctx); err != nil {
			return fmt.Errorf("grouprules: lock device changes: %w", err)
		}
		rows, err := q.AutoSortDevicesForUpdate(ctx)
		if err != nil {
			return fmt.Errorf("grouprules: lock approved devices: %w", err)
		}
		devs := make([]RuleDeviceRef, len(rows))
		approved := make([]uuid.UUID, len(rows))
		for i, r := range rows {
			devs[i] = RuleDeviceRef{ID: r.ID, RustdeskID: r.RustdeskID, Hostname: r.Hostname, Alias: r.Alias, State: r.State, GroupID: r.GroupID}
			approved[i] = r.ID
		}
		out, err = computeAutoSort(ctx, q, devs)
		if err != nil {
			return err
		}
		moveIDs := make([]uuid.UUID, 0, len(out.Moves))
		groupIDs := make([]uuid.UUID, 0, len(out.Moves))
		moveDetails := make([]string, 0, len(out.Moves))
		for _, move := range out.Moves {
			details, err := json.Marshal(map[string]any{
				"before": map[string]any{"group_id": move.Device.GroupID},
				"after":  map[string]any{"group_id": move.To.ID},
				"reason": "auto_sort",
			})
			if err != nil {
				return fmt.Errorf("grouprules: encode move audit: %w", err)
			}
			moveIDs = append(moveIDs, move.Device.ID)
			groupIDs = append(groupIDs, move.To.ID)
			moveDetails = append(moveDetails, string(details))
		}
		if err := q.MoveAutoSortDevices(ctx, db.MoveAutoSortDevicesParams{DeviceIDs: moveIDs, GroupIds: groupIDs}); err != nil {
			return fmt.Errorf("grouprules: auto sort moves: %w", err)
		}
		if err := q.AuditAutoSortMoves(ctx, db.AuditAutoSortMovesParams{ActorID: &a.UserID, ActorIP: a.IP, DeviceIDs: moveIDs, Details: moveDetails}); err != nil {
			return fmt.Errorf("grouprules: audit auto sort moves: %w", err)
		}
		conflicts := make([]uuid.UUID, 0, len(out.Conflicts))
		conflictDetails := make([]string, 0, len(out.Conflicts))
		for _, conflict := range out.Conflicts {
			ids := make([]uuid.UUID, len(conflict.Groups))
			for i, g := range conflict.Groups {
				ids[i] = g.ID
			}
			details, err := json.Marshal(map[string]any{"group_ids": ids})
			if err != nil {
				return fmt.Errorf("grouprules: encode conflict: %w", err)
			}
			conflicts = append(conflicts, conflict.Device.ID)
			conflictDetails = append(conflictDetails, string(details))
		}
		if err := q.UpsertAutoSortConflicts(ctx, db.UpsertAutoSortConflictsParams{DeviceIDs: conflicts, Details: conflictDetails}); err != nil {
			return fmt.Errorf("grouprules: auto sort conflicts: %w", err)
		}
		resolved, err := q.ResolveStaleAutoSortConflicts(ctx, db.ResolveStaleAutoSortConflictsParams{ActorID: &a.UserID, ApprovedIds: approved, ConflictIds: conflicts})
		if err != nil {
			return fmt.Errorf("grouprules: resolve stale auto sort conflicts: %w", err)
		}
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &a.UserID, ActorIP: a.IP,
			Action: ActionAutoSorted, TargetType: "devices", TargetID: "",
			Details: map[string]any{"moved": len(out.Moves), "conflicts": len(out.Conflicts), "resolved": resolved, "unchanged": out.Unchanged},
		})
	})
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "55P03" {
			return AutoSortResult{}, ErrAutoSortBusy
		}
		return AutoSortResult{}, err
	}
	return out, nil
}

func computeAutoSort(ctx context.Context, q *db.Queries, devs []RuleDeviceRef) (AutoSortResult, error) {
	out := AutoSortResult{Moves: []Move{}, Conflicts: []Conflict{}}
	groups, err := q.AutoSortRulesAndGroups(ctx)
	if err != nil {
		return out, fmt.Errorf("grouprules: auto sort groups: %w", err)
	}
	refs := make(map[uuid.UUID]devices.GroupRef, len(groups))
	rules := make([]Rule, 0, len(groups))
	for _, g := range groups {
		refs[g.GroupID] = devices.GroupRef{ID: g.GroupID, Name: g.Name}
		if g.Pattern != nil {
			rules = append(rules, Rule{GroupID: g.GroupID, Pattern: *g.Pattern})
		}
	}
	for _, d := range devs {
		ids := Candidates(rules, d.Hostname)
		switch {
		case len(ids) > 1:
			groups := make([]devices.GroupRef, 0, len(ids))
			for _, id := range ids {
				groups = append(groups, refs[id])
			}
			out.Conflicts = append(out.Conflicts, Conflict{Device: d, Groups: groups})
		case len(ids) == 1 && (d.GroupID == nil || *d.GroupID != ids[0]):
			move := Move{Device: d, To: refs[ids[0]]}
			if d.GroupID != nil {
				ref := refs[*d.GroupID]
				move.From = &ref
			}
			out.Moves = append(out.Moves, move)
		default:
			out.Unchanged++
		}
	}
	return out, nil
}
