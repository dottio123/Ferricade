package adminapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/store/db"
)

const (
	maxPrefsBody = 16 << 10
	maxPinned    = 24
)

type moduleStateJSON struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
	// Size is one of the module's catalog sizes. A request may leave it out
	// (the module's default); responses always carry it.
	Size string `json:"size"`
}

// prefsJSON is both the API shape and what is stored.
type prefsJSON struct {
	Preset          string            `json:"preset"`
	Modules         []moduleStateJSON `json:"modules"`
	PinnedDeviceIDs []string          `json:"pinned_device_ids"`
	Theme           string            `json:"theme"`
	Palette         string            `json:"palette"`
	Density         string            `json:"density"`
	ToastSeconds    int               `json:"toast_seconds"`
	toastSecondsSet bool              `json:"-"`
}

func (p *prefsJSON) UnmarshalJSON(raw []byte) error {
	type plain prefsJSON
	var decoded plain
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	*p = prefsJSON(decoded)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	if rawSeconds, ok := fields["toast_seconds"]; ok {
		rawSeconds = bytes.TrimSpace(rawSeconds)
		var seconds int
		p.toastSecondsSet = len(rawSeconds) > 0 && rawSeconds[0] >= '0' && rawSeconds[0] <= '9' &&
			json.Unmarshal(rawSeconds, &seconds) == nil
	}
	return nil
}

// dashboardCatalog handles GET /dashboard/catalog.
func (a *api) dashboardCatalog(w http.ResponseWriter, r *http.Request) {
	modules, presets := dashboardModules, dashboardPresets
	if scopeOf(userFrom(r.Context())) != nil {
		allowed := map[string]bool{
			"fleet-pulse": true, "quick-connect": true, "needs-attention": true,
			"live-sessions": true, "fleet-overview": true, "recent-sessions": true,
			"session-analytics": true, "platform-mix": true,
		}
		modules = make([]catalogModule, 0, len(allowed))
		for _, m := range dashboardModules {
			if allowed[m.ID] {
				modules = append(modules, m)
			}
		}
		presets = make([]catalogPreset, 0, len(dashboardPresets))
		for _, p := range dashboardPresets {
			if p.ID == "wall" {
				continue
			}
			filtered := catalogPreset{ID: p.ID, Name: p.Name, Modules: []presetModule{}}
			for _, m := range p.Modules {
				if allowed[m.ID] {
					filtered.Modules = append(filtered.Modules, m)
				}
			}
			if len(filtered.Modules) > 0 {
				presets = append(presets, filtered)
			}
		}
	}
	writeJSON(w, http.StatusOK, struct {
		Modules []catalogModule `json:"modules"`
		Presets []catalogPreset `json:"presets"`
	}{modules, presets})
}

func defaultPrefs() prefsJSON {
	p, _ := findPreset(defaultPreset)
	enabled := make([]moduleStateJSON, len(p.Modules))
	for i, m := range p.Modules {
		enabled[i] = moduleStateJSON{ID: m.ID, Enabled: true, Size: m.Size}
	}
	return prefsJSON{
		Preset:          defaultPreset,
		Modules:         normalizeModules(enabled),
		PinnedDeviceIDs: []string{},
		Theme:           "system",
		Palette:         "default",
		Density:         "comfortable",
		ToastSeconds:    5,
		toastSecondsSet: true,
	}
}

// normalizeModules drops unknown and repeated modules and appends the catalog
// modules the list lacks, disabled and in catalog order, so a layout saved
// before the catalog changed still renders. A missing size, or one the module
// no longer offers, becomes the module's default.
func normalizeModules(in []moduleStateJSON) []moduleStateJSON {
	out := make([]moduleStateJSON, 0, len(dashboardModules))
	seen := map[string]bool{}
	for _, m := range in {
		cm, ok := findModule(m.ID)
		if !ok || seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		if !offersSize(m.ID, m.Size) {
			m.Size = cm.DefaultSize
		}
		out = append(out, m)
	}
	for _, m := range dashboardModules {
		if !seen[m.ID] {
			out = append(out, moduleStateJSON{ID: m.ID, Size: m.DefaultSize})
		}
	}
	return out
}

// normalizeStored makes stored preferences safe to serve: values that are no
// longer valid fall back to the defaults and modules are reconciled with the
// catalog.
func normalizeStored(p prefsJSON) prefsJSON {
	def := defaultPrefs()
	if _, ok := findPreset(p.Preset); !ok && p.Preset != "custom" {
		p.Preset = def.Preset
	}
	if !slices.Contains([]string{"dark", "light", "system"}, p.Theme) {
		p.Theme = def.Theme
	}
	if !slices.Contains([]string{"default", "graphite", "ocean", "violet", "moss", "sandstone"}, p.Palette) {
		p.Palette = def.Palette
	}
	if !slices.Contains([]string{"comfortable", "compact"}, p.Density) {
		p.Density = def.Density
	}
	if !p.toastSecondsSet || !slices.Contains([]int{0, 3, 5, 10, 30}, p.ToastSeconds) {
		p.ToastSeconds = def.ToastSeconds
	}
	p.toastSecondsSet = true
	p.Modules = normalizeModules(p.Modules)
	if p.PinnedDeviceIDs == nil {
		p.PinnedDeviceIDs = []string{}
	}
	return p
}

// livePins keeps, in stored order, the pins of devices that still exist and
// are approved. For a User only visible devices count, so a hidden device
// answers like an unknown one.
func livePins(r *http.Request, q *db.Queries, pins []string) ([]string, error) {
	out := []string{}
	if len(pins) == 0 {
		return out, nil
	}
	ids := make([]uuid.UUID, 0, len(pins))
	for _, s := range pins {
		if id, err := uuid.Parse(s); err == nil {
			ids = append(ids, id)
		}
	}
	live, err := q.ApprovedDeviceIDs(r.Context(), db.ApprovedDeviceIDsParams{Ids: ids, ScopeUser: scopeOf(userFrom(r.Context()))})
	if err != nil {
		return nil, err
	}
	ok := make(map[string]bool, len(live))
	for _, id := range live {
		ok[id.String()] = true
	}
	for _, s := range pins {
		if ok[s] {
			out = append(out, s)
		}
	}
	return out, nil
}

// getPreferences handles GET /me/preferences.
func (a *api) getPreferences(w http.ResponseWriter, r *http.Request) {
	q := db.New(a.d.Pool)
	p := defaultPrefs()
	raw, err := q.GetUserPreferences(r.Context(), userFrom(r.Context()).ID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		a.writeInternal(w, r, err)
		return
	default:
		var stored prefsJSON
		// Unreadable stored JSON is treated as nothing stored.
		if json.Unmarshal(raw, &stored) == nil {
			p = normalizeStored(stored)
		} else {
			a.log.Warn("admin api: stored preferences unreadable, using defaults", "user_id", userFrom(r.Context()).ID, "request_id", requestIDFrom(r.Context()))
		}
	}
	if p.PinnedDeviceIDs, err = livePins(r, q, p.PinnedDeviceIDs); err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// putPreferences handles PUT /me/preferences. It is a personal setting, so it
// is not audited.
func (a *api) putPreferences(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Preset          *string            `json:"preset"`
		Modules         *[]moduleStateJSON `json:"modules"`
		PinnedDeviceIDs *[]string          `json:"pinned_device_ids"`
		Theme           *string            `json:"theme"`
		Palette         json.RawMessage    `json:"palette"`
		Density         *string            `json:"density"`
		ToastSeconds    json.RawMessage    `json:"toast_seconds"`
	}
	if !decodeLimit(w, r, &req, maxPrefsBody) {
		return
	}
	bad := func(msg string) { writeError(w, http.StatusBadRequest, codeBadRequest, msg) }
	var requestedPalette *string
	if len(req.Palette) != 0 {
		var value string
		if json.Unmarshal(req.Palette, &value) != nil {
			bad("palette must be default, graphite, ocean, violet, moss or sandstone")
			return
		}
		requestedPalette = &value
	}
	var requestedToastSeconds *int
	if len(req.ToastSeconds) != 0 {
		var value int
		raw := bytes.TrimSpace(req.ToastSeconds)
		if len(raw) == 0 || raw[0] < '0' || raw[0] > '9' || json.Unmarshal(raw, &value) != nil || !slices.Contains([]int{0, 3, 5, 10, 30}, value) {
			bad("toast_seconds must be 0, 3, 5, 10 or 30")
			return
		}
		requestedToastSeconds = &value
	}
	switch {
	case req.Preset == nil || req.Modules == nil || req.PinnedDeviceIDs == nil || req.Theme == nil || req.Density == nil:
		bad("preset, modules, pinned_device_ids, theme and density are required")
		return
	case !slices.Contains([]string{"homelab", "business", "wall", "custom"}, *req.Preset):
		bad("preset must be homelab, business, wall or custom")
		return
	case !slices.Contains([]string{"dark", "light", "system"}, *req.Theme):
		bad("theme must be dark, light or system")
		return
	case requestedPalette != nil && !slices.Contains([]string{"default", "graphite", "ocean", "violet", "moss", "sandstone"}, *requestedPalette):
		bad("palette must be default, graphite, ocean, violet, moss or sandstone")
		return
	case !slices.Contains([]string{"comfortable", "compact"}, *req.Density):
		bad("density must be comfortable or compact")
		return
	case len(*req.PinnedDeviceIDs) > maxPinned:
		bad(fmt.Sprintf("pinned_device_ids has at most %d entries", maxPinned))
		return
	}
	seen := map[string]bool{}
	for _, m := range *req.Modules {
		if !isModuleID(m.ID) {
			bad("modules has an unknown module id")
			return
		}
		if seen[m.ID] {
			bad("modules has a repeated module id")
			return
		}
		if m.Size != "" && !offersSize(m.ID, m.Size) {
			bad(fmt.Sprintf("modules: %s cannot be shown at size %q (see GET /dashboard/catalog)", m.ID, m.Size))
			return
		}
		seen[m.ID] = true
	}
	pins := make([]string, len(*req.PinnedDeviceIDs))
	seen = map[string]bool{}
	for i, s := range *req.PinnedDeviceIDs {
		id, err := uuid.Parse(s)
		if err != nil || seen[id.String()] {
			bad("pinned_device_ids must be unique UUIDs")
			return
		}
		seen[id.String()] = true
		pins[i] = id.String()
	}

	palette := "default"
	toastSeconds := defaultPrefs().ToastSeconds
	if requestedPalette != nil {
		palette = *requestedPalette
	}
	if requestedToastSeconds != nil {
		toastSeconds = *requestedToastSeconds
	}
	if requestedPalette == nil || requestedToastSeconds == nil {
		if storedRaw, err := db.New(a.d.Pool).GetUserPreferences(r.Context(), userFrom(r.Context()).ID); err == nil {
			var stored prefsJSON
			if json.Unmarshal(storedRaw, &stored) == nil {
				stored = normalizeStored(stored)
				if requestedPalette == nil {
					palette = stored.Palette
				}
				if requestedToastSeconds == nil {
					toastSeconds = stored.ToastSeconds
				}
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			a.writeInternal(w, r, err)
			return
		}
	}
	p := prefsJSON{
		Preset: *req.Preset, Modules: normalizeModules(*req.Modules), PinnedDeviceIDs: pins,
		Theme: *req.Theme, Palette: palette, Density: *req.Density, ToastSeconds: toastSeconds,
		toastSecondsSet: true,
	}
	raw, err := json.Marshal(p)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	q := db.New(a.d.Pool)
	if err := q.PutUserPreferences(r.Context(), db.PutUserPreferencesParams{
		UserID: userFrom(r.Context()).ID, Prefs: raw, UpdatedAt: a.now(),
	}); err != nil {
		a.writeInternal(w, r, err)
		return
	}
	if p.PinnedDeviceIDs, err = livePins(r, q, p.PinnedDeviceIDs); err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}
