package adminapi

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

type grantsJSON struct {
	GroupIDs  []uuid.UUID `json:"group_ids"`
	DeviceIDs []uuid.UUID `json:"device_ids"`
}

func emptyGrants() grantsJSON {
	return grantsJSON{GroupIDs: []uuid.UUID{}, DeviceIDs: []uuid.UUID{}}
}

func grantsFromRows(rows []db.ListUserGrantsRow) grantsJSON {
	out := emptyGrants()
	for _, row := range rows {
		if row.GroupID != nil {
			out.GroupIDs = append(out.GroupIDs, *row.GroupID)
		}
		if row.DeviceID != nil {
			out.DeviceIDs = append(out.DeviceIDs, *row.DeviceID)
		}
	}
	sortGrantIDs(out.GroupIDs)
	sortGrantIDs(out.DeviceIDs)
	return out
}

func sortGrantIDs(ids []uuid.UUID) {
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
}

func (a *api) getUserGrants(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	q := db.New(a.d.Pool)
	user, err := q.GetUserByID(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		notFound(w, r)
		return
	}
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("get grant target: %w", err))
		return
	}
	out := emptyGrants()
	if user.Role == roleUser {
		rows, err := q.ListUserGrants(r.Context(), id)
		if err != nil {
			a.writeInternal(w, r, fmt.Errorf("list user grants: %w", err))
			return
		}
		out = grantsFromRows(rows)
	}
	writeJSON(w, http.StatusOK, out)
}

func validGrantIDs(ids []uuid.UUID) bool {
	if len(ids) > 256 {
		return false
	}
	seen := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func grantDifference(a, b []uuid.UUID) []uuid.UUID {
	other := make(map[uuid.UUID]bool, len(b))
	for _, id := range b {
		other[id] = true
	}
	out := []uuid.UUID{}
	for _, id := range a {
		if !other[id] {
			out = append(out, id)
		}
	}
	sortGrantIDs(out)
	return out
}

func (a *api) putUserGrants(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		GroupIDs  *[]uuid.UUID `json:"group_ids"`
		DeviceIDs *[]uuid.UUID `json:"device_ids"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.GroupIDs == nil || req.DeviceIDs == nil || !validGrantIDs(*req.GroupIDs) || !validGrantIDs(*req.DeviceIDs) {
		writeError(w, http.StatusBadRequest, codeBadRequest, "group_ids and device_ids must be arrays of at most 256 unique IDs")
		return
	}
	want := grantsJSON{GroupIDs: *req.GroupIDs, DeviceIDs: *req.DeviceIDs}
	sortGrantIDs(want.GroupIDs)
	sortGrantIDs(want.DeviceIDs)
	ctx := r.Context()
	err := store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		// Keep the same owner-before-target lock order as PATCH /users/{id}.
		if _, err := q.CountActiveOwners(ctx); err != nil {
			return fmt.Errorf("lock owners: %w", err)
		}
		user, err := q.GetUserByIDForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return &apiError{http.StatusNotFound, codeNotFound, "not found"}
		}
		if err != nil {
			return fmt.Errorf("lock grant target: %w", err)
		}
		if user.Role != roleUser {
			return &apiError{http.StatusConflict, codeBadTransition, "grants apply to the user role only"}
		}
		groups, err := q.ExistingGroupIDs(ctx, want.GroupIDs)
		if err != nil {
			return fmt.Errorf("check groups: %w", err)
		}
		devices, err := q.ExistingDeviceIDs(ctx, want.DeviceIDs)
		if err != nil {
			return fmt.Errorf("check devices: %w", err)
		}
		if len(groups) != len(want.GroupIDs) || len(devices) != len(want.DeviceIDs) {
			return &apiError{http.StatusBadRequest, codeBadRequest, "unknown group or device ID"}
		}
		rows, err := q.ListUserGrants(ctx, id)
		if err != nil {
			return fmt.Errorf("list prior grants: %w", err)
		}
		before := grantsFromRows(rows)
		if err := q.DeleteUserGrants(ctx, id); err != nil {
			return fmt.Errorf("delete user grants: %w", err)
		}
		if len(want.GroupIDs) > 0 {
			if err := q.InsertUserGroupGrants(ctx, db.InsertUserGroupGrantsParams{UserID: id, Column2: want.GroupIDs, CreatedBy: &act.UserID}); err != nil {
				return fmt.Errorf("insert group grants: %w", err)
			}
		}
		if len(want.DeviceIDs) > 0 {
			if err := q.InsertUserDeviceGrants(ctx, db.InsertUserDeviceGrantsParams{UserID: id, Column2: want.DeviceIDs, CreatedBy: &act.UserID}); err != nil {
				return fmt.Errorf("insert device grants: %w", err)
			}
		}
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &act.UserID, ActorIP: act.IP, Action: "user.grants_updated",
			TargetType: targetUser, TargetID: id.String(),
			Details: map[string]any{
				"added_group_ids":    grantDifference(want.GroupIDs, before.GroupIDs),
				"removed_group_ids":  grantDifference(before.GroupIDs, want.GroupIDs),
				"added_device_ids":   grantDifference(want.DeviceIDs, before.DeviceIDs),
				"removed_device_ids": grantDifference(before.DeviceIDs, want.DeviceIDs),
			},
		})
	})
	if err != nil {
		if !writeAPIError(w, err) {
			a.writeInternal(w, r, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, want)
}
