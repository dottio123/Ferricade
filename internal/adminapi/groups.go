package adminapi

import (
	"context"
	"fmt"
	"net/http"

	"github.com/google/uuid"

	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store/db"
)

type groupJSON struct {
	ID                uuid.UUID   `json:"id"`
	ParentID          *uuid.UUID  `json:"parent_id"`
	PolicyID          *uuid.UUID  `json:"policy_id"`
	EffectivePolicyID uuid.UUID   `json:"effective_policy_id"`
	Name              string      `json:"name"`
	Children          []groupJSON `json:"children"`
}

func toGroupJSON(g devices.Group, effective map[uuid.UUID]uuid.UUID) groupJSON {
	out := groupJSON{ID: g.ID, ParentID: g.ParentID, PolicyID: g.PolicyID, EffectivePolicyID: effective[g.ID], Name: g.Name, Children: make([]groupJSON, len(g.Children))}
	for i, c := range g.Children {
		out.Children[i] = toGroupJSON(c, effective)
	}
	return out
}

func (a *api) groupEffectivePolicies(ctx context.Context) (map[uuid.UUID]uuid.UUID, error) {
	rows, err := db.New(a.d.Pool).ListGroupEffectivePolicies(ctx)
	if err != nil {
		return nil, fmt.Errorf("adminapi: effective group policies: %w", err)
	}
	effective := make(map[uuid.UUID]uuid.UUID, len(rows))
	for _, row := range rows {
		effective[row.GroupID] = row.EffectivePolicyID
	}
	return effective, nil
}

func (a *api) writeGroup(w http.ResponseWriter, r *http.Request, status int, g devices.Group) {
	effective, err := a.groupEffectivePolicies(r.Context())
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, status, toGroupJSON(g, effective))
}

// listGroups handles GET /groups: the whole tree, root groups as items.
func (a *api) listGroups(w http.ResponseWriter, r *http.Request) {
	tree, err := a.d.Groups.Tree(r.Context(), scopeOf(userFrom(r.Context())))
	if err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	effective, err := a.groupEffectivePolicies(r.Context())
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	out := listJSON[groupJSON]{Items: make([]groupJSON, len(tree))}
	for i, g := range tree {
		out.Items[i] = toGroupJSON(g, effective)
	}
	writeJSON(w, http.StatusOK, out)
}

// createGroup handles POST /groups.
func (a *api) createGroup(w http.ResponseWriter, r *http.Request) {
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Name     string     `json:"name"`
		ParentID *uuid.UUID `json:"parent_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	g, err := a.d.Groups.Create(r.Context(), act, req.Name, req.ParentID)
	if err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	a.writeGroup(w, r, http.StatusCreated, g)
}

// renameGroup handles PATCH /groups/{id}.
func (a *api) renameGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &req) {
		return
	}
	g, err := a.d.Groups.Rename(r.Context(), act, id, req.Name)
	if err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	a.writeGroup(w, r, http.StatusOK, g)
}

// moveGroup handles POST /groups/{id}/move. parent_id is required; null
// makes the group a root.
func (a *api) moveGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		ParentID nullable[uuid.UUID] `json:"parent_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	if !req.ParentID.set {
		writeError(w, http.StatusBadRequest, codeBadRequest, "parent_id is required (null for a root group)")
		return
	}
	g, err := a.d.Groups.Move(r.Context(), act, id, req.ParentID.v)
	if err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	a.writeGroup(w, r, http.StatusOK, g)
}

// deleteGroup handles DELETE /groups/{id}.
func (a *api) deleteGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	if err := a.d.Groups.Delete(r.Context(), act, id); err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
