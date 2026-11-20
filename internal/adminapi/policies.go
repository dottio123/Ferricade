package adminapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/policies"
	"github.com/dottio123/ferricade/internal/store/db"
)

type policyJSON struct {
	ID        uuid.UUID         `json:"id"`
	Name      string            `json:"name"`
	IsDefault bool              `json:"is_default"`
	Settings  policies.Settings `json:"settings"`
	UpdatedAt time.Time         `json:"updated_at"`
	UpdatedBy *deploymentActor  `json:"updated_by"`
}

type policyPushJSON struct {
	Enabled   bool             `json:"enabled"`
	UpdatedAt time.Time        `json:"updated_at"`
	UpdatedBy *deploymentActor `json:"updated_by"`
}

func (a *api) policyActor(ctx context.Context, id *uuid.UUID) (*deploymentActor, error) {
	return a.policyActorWithQueries(ctx, db.New(a.d.Pool), id)
}

func (a *api) policyActorWithQueries(ctx context.Context, q *db.Queries, id *uuid.UUID) (*deploymentActor, error) {
	if id == nil {
		return nil, nil
	}
	u, err := q.GetUserByID(ctx, *id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("adminapi: policy actor: %w", err)
	}
	return &deploymentActor{ID: u.ID, DisplayName: u.DisplayName}, nil
}

func (a *api) policyResponse(ctx context.Context, p policies.Policy) (policyJSON, error) {
	var actor *deploymentActor
	var err error
	if p.UpdatedByDisplayName != nil && p.UpdatedBy != nil {
		actor = &deploymentActor{ID: *p.UpdatedBy, DisplayName: *p.UpdatedByDisplayName}
	} else {
		actor, err = a.policyActor(ctx, p.UpdatedBy)
	}
	return policyJSON{ID: p.ID, Name: p.Name, IsDefault: p.IsDefault, Settings: p.Settings, UpdatedAt: p.UpdatedAt, UpdatedBy: actor}, err
}

func (a *api) writePolicy(w http.ResponseWriter, r *http.Request, status int, p policies.Policy) {
	out, err := a.policyResponse(r.Context(), p)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, status, out)
}

func (a *api) writePoliciesError(w http.ResponseWriter, r *http.Request, err error) {
	var validation *policies.ValidationError
	switch {
	case errors.As(err, &validation):
		writeError(w, http.StatusBadRequest, codeBadRequest, validation.Error())
	case errors.Is(err, policies.ErrNotFound):
		writeError(w, http.StatusNotFound, codeNotFound, "not found")
	case errors.Is(err, policies.ErrNameTaken):
		writeError(w, http.StatusConflict, codeNameTaken, "name taken")
	case errors.Is(err, policies.ErrInUse):
		writeError(w, http.StatusConflict, codeInUse, "policy in use")
	case errors.Is(err, policies.ErrDefaultPolicy):
		writeError(w, http.StatusConflict, codeDefaultPolicy, "default policy")
	case errors.Is(err, policies.ErrWindowOpen):
		writeError(w, http.StatusConflict, codeWindowOpen, "access window already open")
	case errors.Is(err, policies.ErrPushOff):
		writeError(w, http.StatusConflict, codePushOff, "policy push is off")
	case errors.Is(err, policies.ErrAlwaysReachable):
		writeError(w, http.StatusConflict, codeAlwaysReachable, "policy is always reachable")
	case errors.Is(err, policies.ErrNotApproved):
		writeError(w, http.StatusConflict, codeBadTransition, "device is not approved")
	default:
		a.writeInternal(w, r, err)
	}
}

func (a *api) listPolicies(w http.ResponseWriter, r *http.Request) {
	list, err := a.d.Policies.List(r.Context())
	if err != nil {
		a.writePoliciesError(w, r, err)
		return
	}
	out := struct {
		Items []policyJSON `json:"items"`
	}{Items: make([]policyJSON, 0, len(list))}
	for _, p := range list {
		item, err := a.policyResponse(r.Context(), p)
		if err != nil {
			a.writeInternal(w, r, err)
			return
		}
		out.Items = append(out.Items, item)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *api) createPolicy(w http.ResponseWriter, r *http.Request) {
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Name     *string            `json:"name"`
		Settings *policies.Settings `json:"settings"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Name == nil || req.Settings == nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, "name and settings are required")
		return
	}
	p, err := a.d.Policies.Create(r.Context(), act, *req.Name, *req.Settings)
	if err != nil {
		a.writePoliciesError(w, r, err)
		return
	}
	a.writePolicy(w, r, http.StatusCreated, p)
}

func (a *api) getPolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	p, err := a.d.Policies.Get(r.Context(), id)
	if err != nil {
		a.writePoliciesError(w, r, err)
		return
	}
	a.writePolicy(w, r, http.StatusOK, p)
}

func (a *api) updatePolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Name     *string            `json:"name"`
		Settings *policies.Settings `json:"settings"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Name == nil && req.Settings == nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, "name or settings is required")
		return
	}
	p, err := a.d.Policies.Update(r.Context(), act, id, req.Name, req.Settings)
	if err != nil {
		a.writePoliciesError(w, r, err)
		return
	}
	a.writePolicy(w, r, http.StatusOK, p)
}

func (a *api) deletePolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	if err := a.d.Policies.Delete(r.Context(), act, id); err != nil {
		a.writePoliciesError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) getPolicyPush(w http.ResponseWriter, r *http.Request) {
	enabled, at, by, err := a.d.Policies.PushEnabled(r.Context())
	if err != nil {
		a.writePoliciesError(w, r, err)
		return
	}
	actor, err := a.policyActor(r.Context(), by)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, policyPushJSON{Enabled: enabled, UpdatedAt: at, UpdatedBy: actor})
}

func (a *api) putPolicyPush(w http.ResponseWriter, r *http.Request) {
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Enabled *bool `json:"enabled"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Enabled == nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, "enabled is required")
		return
	}
	if err := a.d.Policies.SetPushEnabled(r.Context(), act, *req.Enabled); err != nil {
		if errors.Is(err, policies.ErrWindowOpen) {
			writeError(w, http.StatusConflict, codeWindowOpen, "close the open access windows first")
			return
		}
		a.writePoliciesError(w, r, err)
		return
	}
	a.getPolicyPush(w, r)
}

func (a *api) putGroupPolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		PolicyID nullable[uuid.UUID] `json:"policy_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	if !req.PolicyID.set {
		writeError(w, http.StatusBadRequest, codeBadRequest, "policy_id is required")
		return
	}
	if err := a.d.Policies.SetGroupPolicy(r.Context(), act, id, req.PolicyID.v); err != nil {
		a.writePoliciesError(w, r, err)
		return
	}
	row, err := db.New(a.d.Pool).GetGroupForUpdate(r.Context(), id)
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("adminapi: get group after policy change: %w", err))
		return
	}
	a.writeGroup(w, r, http.StatusOK, devices.Group{ID: row.ID, ParentID: row.ParentID, PolicyID: row.PolicyID, Name: row.Name, Children: []devices.Group{}})
}

type accessWindowJSON struct {
	ID                uuid.UUID        `json:"id"`
	OpenedBy          *deploymentActor `json:"opened_by"`
	OpenedAt          time.Time        `json:"opened_at"`
	EndsAt            *time.Time       `json:"ends_at"`
	DisconnectOnClose bool             `json:"disconnect_on_close"`
}

func (a *api) windowResponse(ctx context.Context, row policies.WindowRow) (accessWindowJSON, error) {
	actor, err := a.policyActor(ctx, row.OpenedBy)
	return accessWindowJSON{ID: row.ID, OpenedBy: actor, OpenedAt: row.OpenedAt, EndsAt: row.EndsAt, DisconnectOnClose: row.DisconnectOnClose}, err
}

func (a *api) getDevicePolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	q := db.New(a.d.Pool)
	var err error
	if scope := scopeOf(userFrom(r.Context())); scope != nil {
		_, err = q.GetVisibleDevice(r.Context(), db.GetVisibleDeviceParams{ID: id, UserID: *scope})
	} else {
		_, err = q.GetDevice(r.Context(), id)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		a.writeDevicesError(w, r, devices.ErrNotFound)
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	st, err := a.d.Policies.DeviceStatus(r.Context(), id)
	if err != nil {
		a.writePoliciesError(w, r, err)
		return
	}
	var window *accessWindowJSON
	if st.Window != nil {
		v, err := a.windowResponse(r.Context(), *st.Window)
		if err != nil {
			a.writeInternal(w, r, err)
			return
		}
		window = &v
	}
	user := userFrom(r.Context())
	var visibleGroups map[uuid.UUID]bool
	if user.Role == "user" {
		visibleGroups, err = a.visibleGroupSet(r.Context(), user.ID)
		if err != nil {
			a.writeInternal(w, r, fmt.Errorf("adminapi: get visible groups for policy status: %w", err))
			return
		}
		if window != nil {
			window.OpenedBy = nil
		}
	}
	var group *struct {
		ID   uuid.UUID `json:"id"`
		Name string    `json:"name"`
	}
	if st.Resolved.SourceGroupID != nil && (user.Role != "user" || visibleGroups[*st.Resolved.SourceGroupID]) {
		group = &struct {
			ID   uuid.UUID `json:"id"`
			Name string    `json:"name"`
		}{*st.Resolved.SourceGroupID, st.Resolved.SourceGroupName}
	}
	writeJSON(w, http.StatusOK, struct {
		PushEnabled bool `json:"push_enabled"`
		Policy      struct {
			ID   uuid.UUID `json:"id"`
			Name string    `json:"name"`
		} `json:"policy"`
		Source                string            `json:"source"`
		SourceGroup           any               `json:"source_group"`
		EffectiveSettings     policies.Settings `json:"effective_settings"`
		Status                string            `json:"status"`
		Connect               string            `json:"connect"`
		AlwaysReachable       bool              `json:"always_reachable"`
		Window                *accessWindowJSON `json:"window"`
		CloseUnconfirmedSince *time.Time        `json:"close_unconfirmed_since"`
	}{PushEnabled: st.PushEnabled, Policy: struct {
		ID   uuid.UUID `json:"id"`
		Name string    `json:"name"`
	}{st.Resolved.Policy.ID, st.Resolved.Policy.Name}, Source: st.Resolved.Source, SourceGroup: group, EffectiveSettings: st.Effective, Status: st.State, Connect: st.Connect, AlwaysReachable: st.AlwaysReachable, Window: window, CloseUnconfirmedSince: st.CloseUnconfirmedSince})
}

func (a *api) openAccessWindow(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	actor, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Duration          nullable[int] `json:"duration_minutes"`
		DisconnectOnClose *bool         `json:"disconnect_on_close"`
	}
	if !decode(w, r, &req) {
		return
	}
	if !req.Duration.set || req.DisconnectOnClose == nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, "duration_minutes and disconnect_on_close are required")
		return
	}
	row, err := a.d.Policies.OpenWindow(r.Context(), actor, id, req.Duration.v, *req.DisconnectOnClose)
	if err != nil {
		a.writePoliciesError(w, r, err)
		return
	}
	out, err := a.windowResponse(r.Context(), row)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (a *api) closeAccessWindow(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	actor, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Disconnect *bool `json:"disconnect"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Disconnect == nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, "disconnect is required")
		return
	}
	if err := a.d.Policies.CloseWindow(r.Context(), actor, id, *req.Disconnect); err != nil {
		a.writePoliciesError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
