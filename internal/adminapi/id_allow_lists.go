package adminapi

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// RustDesk 1.5.0 accepts alphabetic custom IDs and numeric default IDs
// (libs/hbb_common/src/lib.rs:257-259); the whitelist strips @ and compares
// case-insensitively (src/server/connection.rs:7051-7059,7089).
var idAllowListPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_]{5,15}$`)

type idAllowListJSON struct {
	IDs []string `json:"ids"`
}

type effectiveIDAllowListJSON struct {
	ID        string     `json:"id"`
	Source    string     `json:"source"`
	GroupID   *uuid.UUID `json:"group_id"`
	GroupName *string    `json:"group_name"`
}

type deviceIDAllowListJSON struct {
	IDs       []string                   `json:"ids"`
	Effective []effectiveIDAllowListJSON `json:"effective"`
}

func validateIDAllowList(ids []string) ([]string, string) {
	if len(ids) > 200 {
		return nil, "ids must contain at most 200 entries"
	}
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if !idAllowListPattern.MatchString(id) {
			return nil, "ids must be 6-16 letters, digits or underscores and start with a letter or digit"
		}
		key := strings.ToLower(id)
		if _, ok := seen[key]; ok {
			return nil, "ids must not contain duplicates ignoring case"
		}
		seen[key] = struct{}{}
	}
	return append([]string{}, ids...), ""
}

func (a *api) readIDAllowList(w http.ResponseWriter, r *http.Request) ([]string, bool) {
	var req struct {
		IDs *[]string `json:"ids"`
	}
	if !decode(w, r, &req) {
		return nil, false
	}
	if req.IDs == nil {
		writeError(w, http.StatusBadRequest, codeValidationError, "ids is required")
		return nil, false
	}
	ids, message := validateIDAllowList(*req.IDs)
	if message != "" {
		writeError(w, http.StatusBadRequest, codeValidationError, message)
		return nil, false
	}
	return ids, true
}

func replaceIDAllowList(ctx context.Context, a *api, actor devices.Actor, scope, target string, ids []string,
	lock func(*db.Queries, context.Context) ([]string, error),
	set func(*db.Queries, context.Context, []string) error,
) error {
	return store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		before, err := lock(q, ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return devices.ErrNotFound
		}
		if err != nil {
			return err
		}
		if err := set(q, ctx, ids); err != nil {
			return err
		}
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &actor.UserID, ActorIP: actor.IP,
			Action: "id_allow_list.updated", TargetType: "id_allow_list", TargetID: target,
			Details: map[string]any{"scope": scope, "target_id": target, "before": before, "after": ids},
		})
	})
}

func (a *api) getGlobalIDAllowList(w http.ResponseWriter, r *http.Request) {
	ids, err := db.New(a.d.Pool).GetGlobalIDAllowList(r.Context())
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	if ids == nil {
		ids = []string{}
	}
	writeJSON(w, http.StatusOK, idAllowListJSON{IDs: ids})
}

func (a *api) putGlobalIDAllowList(w http.ResponseWriter, r *http.Request) {
	ids, ok := a.readIDAllowList(w, r)
	if !ok {
		return
	}
	actor, ok := a.actor(w, r)
	if !ok {
		return
	}
	err := replaceIDAllowList(r.Context(), a, actor, "global", "global", ids,
		func(q *db.Queries, ctx context.Context) ([]string, error) { return q.LockGlobalIDAllowList(ctx) },
		func(q *db.Queries, ctx context.Context, ids []string) error { return q.SetGlobalIDAllowList(ctx, ids) })
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, idAllowListJSON{IDs: ids})
}

func (a *api) getGroupIDAllowList(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	ids, err := db.New(a.d.Pool).GetGroupIDAllowList(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, codeNotFound, "not found")
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	if ids == nil {
		ids = []string{}
	}
	writeJSON(w, http.StatusOK, idAllowListJSON{IDs: ids})
}

func (a *api) putGroupIDAllowList(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	ids, ok := a.readIDAllowList(w, r)
	if !ok {
		return
	}
	actor, ok := a.actor(w, r)
	if !ok {
		return
	}
	err := replaceIDAllowList(r.Context(), a, actor, "group", id.String(), ids,
		func(q *db.Queries, ctx context.Context) ([]string, error) { return q.LockGroupIDAllowList(ctx, id) },
		func(q *db.Queries, ctx context.Context, ids []string) error {
			return q.SetGroupIDAllowList(ctx, db.SetGroupIDAllowListParams{ID: id, Ids: ids})
		})
	if errors.Is(err, devices.ErrNotFound) {
		writeError(w, http.StatusNotFound, codeNotFound, "not found")
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, idAllowListJSON{IDs: ids})
}

func (a *api) getDeviceIDAllowList(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	a.writeDeviceIDAllowList(w, r, id)
}

func (a *api) putDeviceIDAllowList(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	ids, ok := a.readIDAllowList(w, r)
	if !ok {
		return
	}
	actor, ok := a.actor(w, r)
	if !ok {
		return
	}
	err := replaceIDAllowList(r.Context(), a, actor, "device", id.String(), ids,
		func(q *db.Queries, ctx context.Context) ([]string, error) { return q.LockDeviceIDAllowList(ctx, id) },
		func(q *db.Queries, ctx context.Context, ids []string) error {
			return q.SetDeviceIDAllowList(ctx, db.SetDeviceIDAllowListParams{ID: id, Ids: ids})
		})
	if errors.Is(err, devices.ErrNotFound) {
		writeError(w, http.StatusNotFound, codeNotFound, "not found")
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	a.writeDeviceIDAllowList(w, r, id)
}

func (a *api) writeDeviceIDAllowList(w http.ResponseWriter, r *http.Request, deviceID uuid.UUID) {
	q := db.New(a.d.Pool)
	ids, err := q.GetDeviceIDAllowList(r.Context(), deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, codeNotFound, "not found")
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	rows, err := q.ListEffectiveDeviceIDAllowList(r.Context(), deviceID)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	out := deviceIDAllowListJSON{IDs: ids, Effective: make([]effectiveIDAllowListJSON, len(rows))}
	for i, row := range rows {
		out.Effective[i] = effectiveIDAllowListJSON{ID: row.ID, Source: row.Source, GroupID: row.GroupID, GroupName: row.GroupName}
	}
	sort.Slice(out.Effective, func(i, j int) bool {
		if out.Effective[i].ID != out.Effective[j].ID {
			return out.Effective[i].ID < out.Effective[j].ID
		}
		return out.Effective[i].Source < out.Effective[j].Source
	})
	writeJSON(w, http.StatusOK, out)
}
