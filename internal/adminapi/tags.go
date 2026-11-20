package adminapi

import (
	"net/http"

	"github.com/dottio123/ferricade/internal/devices"
)

// listTags handles GET /tags.
func (a *api) listTags(w http.ResponseWriter, r *http.Request) {
	limit, cursor, ok := page(w, r)
	if !ok {
		return
	}
	tags, next, err := a.d.Tags.List(r.Context(), limit, cursor, scopeOf(userFrom(r.Context())))
	if err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	out := listJSON[tagJSON]{Items: make([]tagJSON, len(tags)), NextCursor: next}
	for i, t := range tags {
		out.Items[i] = toTagJSON(t)
	}
	writeJSON(w, http.StatusOK, out)
}

// createTag handles POST /tags.
func (a *api) createTag(w http.ResponseWriter, r *http.Request) {
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Name  string `json:"name"`
		Color int64  `json:"color"`
	}
	if !decode(w, r, &req) {
		return
	}
	t, err := a.d.Tags.Create(r.Context(), act, req.Name, req.Color)
	if err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, toTagJSON(t))
}

// updateTag handles PATCH /tags/{id}.
func (a *api) updateTag(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Name  *string `json:"name"`
		Color *int64  `json:"color"`
	}
	if !decode(w, r, &req) {
		return
	}
	t, err := a.d.Tags.Update(r.Context(), act, id, devices.TagPatch{Name: req.Name, Color: req.Color})
	if err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toTagJSON(t))
}

// deleteTag handles DELETE /tags/{id}; the tag is detached from its devices.
func (a *api) deleteTag(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	if err := a.d.Tags.Delete(r.Context(), act, id); err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
