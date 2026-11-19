package adminapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

var catalogIDs = []string{
	"fleet-pulse", "quick-connect", "approval-queue", "needs-attention", "live-sessions",
	"activity-trend", "fleet-overview", "recent-sessions", "session-analytics", "platform-mix", "admin-activity",
}

var businessEnabled = []string{
	"fleet-pulse", "needs-attention", "approval-queue", "live-sessions",
	"fleet-overview", "activity-trend", "admin-activity", "platform-mix",
}

// sizeRank maps size names to 0, 1, 2 so their order can be checked.
func sizeRank(names []string) []int {
	rank := map[string]int{"small": 0, "medium": 1, "large": 2}
	out := make([]int, len(names))
	for i, n := range names {
		out[i] = rank[n]
	}
	return out
}

// moduleSizes returns each module's size in a preferences body.
func moduleSizes(t *testing.T, body map[string]any) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, m := range body["modules"].([]any) {
		mm := m.(map[string]any)
		out[mm["id"].(string)] = mm["size"].(string)
	}
	return out
}

// moduleList returns the modules of a preferences body as ids and enabled flags.
func moduleList(t *testing.T, body map[string]any) (ids []string, enabled []bool) {
	t.Helper()
	for _, m := range body["modules"].([]any) {
		mm := m.(map[string]any)
		ids = append(ids, mm["id"].(string))
		enabled = append(enabled, mm["enabled"].(bool))
	}
	return ids, enabled
}

func allModules(enabled map[string]bool, order []string) []map[string]any {
	out := make([]map[string]any, len(order))
	for i, id := range order {
		out[i] = map[string]any{"id": id, "enabled": enabled[id]}
	}
	return out
}

func TestCatalog(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "admin")
	body := c.ok(http.MethodGet, apiPrefix+"/dashboard/catalog", nil)

	// Shapes are columns x rows of a 4-column grid with fixed-height rows.
	shape := func(cols, rows int) []any { return []any{float64(cols), float64(rows)} }
	// Fleet pulse is four numbers: no large size to fill.
	pulse := map[string][]any{"small": shape(2, 1), "medium": shape(4, 1)}
	list := map[string][]any{"small": shape(1, 2), "medium": shape(2, 2), "large": shape(2, 3)}
	big := map[string][]any{"small": shape(2, 2), "medium": shape(4, 2), "large": shape(4, 3)}
	mix := map[string][]any{"small": shape(1, 2), "medium": shape(2, 2)}
	type wantModule struct {
		def    string
		shapes map[string][]any
	}
	wantModules := map[string]wantModule{
		"fleet-pulse": {"medium", pulse}, "quick-connect": {"medium", list}, "approval-queue": {"medium", list},
		"needs-attention": {"medium", list}, "live-sessions": {"medium", list}, "activity-trend": {"medium", big},
		"fleet-overview": {"medium", big}, "recent-sessions": {"medium", list}, "session-analytics": {"small", big},
		"platform-mix": {"medium", mix}, "admin-activity": {"medium", list},
	}
	mods := body["modules"].([]any)
	require.Len(t, mods, len(catalogIDs))
	for i, m := range mods {
		mm := m.(map[string]any)
		require.Equal(t, catalogIDs[i], mm["id"])
		want := wantModules[catalogIDs[i]]
		require.Equal(t, want.def, mm["default_size"], catalogIDs[i])
		got := map[string][]any{}
		var names []string
		for _, s := range mm["sizes"].([]any) {
			sm := s.(map[string]any)
			names = append(names, sm["name"].(string))
			got[sm["name"].(string)] = []any{sm["cols"], sm["rows"]}
		}
		require.Equal(t, want.shapes, got, catalogIDs[i])
		require.IsIncreasing(t, sizeRank(names), "sizes are listed small to large")
	}

	ps := func(pairs ...string) []any {
		out := []any{}
		for i := 0; i < len(pairs); i += 2 {
			out = append(out, map[string]any{"id": pairs[i], "size": pairs[i+1]})
		}
		return out
	}
	// Ordered so each preset packs into full rows of the 4-column grid.
	want := []map[string]any{
		{"id": "homelab", "name": "Homelab", "modules": ps(
			"fleet-pulse", "medium", "needs-attention", "medium", "quick-connect", "medium",
			"live-sessions", "medium", "recent-sessions", "medium", "fleet-overview", "medium")},
		{"id": "business", "name": "Business", "modules": ps(
			"fleet-pulse", "medium", "needs-attention", "medium", "approval-queue", "medium",
			"live-sessions", "medium", "fleet-overview", "small", "activity-trend", "medium",
			"admin-activity", "medium", "platform-mix", "medium")},
		{"id": "wall", "name": "Monitoring wall", "modules": ps(
			"fleet-pulse", "medium", "needs-attention", "medium", "live-sessions", "medium",
			"fleet-overview", "medium", "activity-trend", "medium")},
	}
	presets := body["presets"].([]any)
	require.Len(t, presets, 3)
	for i, p := range presets {
		pm := p.(map[string]any)
		require.Equal(t, want[i]["id"], pm["id"])
		require.Equal(t, want[i]["name"], pm["name"])
		require.Equal(t, want[i]["modules"], pm["modules"])
	}

	require.Equal(t, http.StatusUnauthorized, e.client().do(http.MethodGet, apiPrefix+"/dashboard/catalog", nil).Code)
}

func TestPreferencesDefault(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "admin")
	body := c.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)

	require.Equal(t, "business", body["preset"])
	require.Equal(t, "system", body["theme"])
	require.Equal(t, "default", body["palette"])
	require.Equal(t, "comfortable", body["density"])
	require.Equal(t, []any{}, body["pinned_device_ids"])
	require.Equal(t, float64(5), body["toast_seconds"])
	ids, enabled := moduleList(t, body)
	var on []string
	for i := range ids {
		if enabled[i] {
			on = append(on, ids[i])
		}
	}
	require.Equal(t, businessEnabled, ids[:len(businessEnabled)])
	require.Equal(t, businessEnabled, on)
	// The rest follow, disabled, in catalog order.
	require.Equal(t, []string{"quick-connect", "recent-sessions", "session-analytics"}, ids[len(businessEnabled):])
	// Every module carries a size: the preset's for its modules, else the default.
	sizes := moduleSizes(t, body)
	require.Len(t, sizes, len(catalogIDs))
	require.Equal(t, "medium", sizes["fleet-pulse"])
	require.Equal(t, "small", sizes["session-analytics"], "not in business: its default")
}

func TestPreferencesToastSeconds(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "admin")
	base := func() map[string]any {
		return map[string]any{
			"preset": "business", "modules": allModules(nil, catalogIDs),
			"pinned_device_ids": []string{}, "theme": "system", "density": "comfortable",
		}
	}
	put := func(seconds any) map[string]any {
		body := base()
		body["toast_seconds"] = seconds
		return body
	}
	require.Equal(t, float64(5), c.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)["toast_seconds"])
	require.Equal(t, float64(10), c.ok(http.MethodPut, apiPrefix+"/me/preferences", put(10))["toast_seconds"])
	without := c.ok(http.MethodPut, apiPrefix+"/me/preferences", base())
	require.Equal(t, float64(10), without["toast_seconds"])
	require.Equal(t, float64(10), c.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)["toast_seconds"])
	require.Equal(t, float64(0), c.ok(http.MethodPut, apiPrefix+"/me/preferences", put(0))["toast_seconds"])
	for _, invalid := range []any{7, "10"} {
		requireError(t, c.do(http.MethodPut, apiPrefix+"/me/preferences", put(invalid)), http.StatusBadRequest, codeBadRequest)
	}
}

func TestPreferencesSizes(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "admin")

	mods := allModules(map[string]bool{"fleet-pulse": true, "activity-trend": true}, catalogIDs)
	for _, m := range mods {
		switch m["id"] {
		case "fleet-pulse":
			m["size"] = "small"
		case "activity-trend":
			m["size"] = "small"
		}
	}
	req := map[string]any{
		"preset": "custom", "modules": mods, "pinned_device_ids": []string{}, "theme": "system", "density": "comfortable",
	}
	put := c.ok(http.MethodPut, apiPrefix+"/me/preferences", req)
	got := c.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)
	require.Equal(t, put, got)
	sizes := moduleSizes(t, got)
	require.Equal(t, "small", sizes["fleet-pulse"])
	require.Equal(t, "small", sizes["activity-trend"])
	require.Equal(t, "medium", sizes["approval-queue"], "a module sent without a size gets its default")

	bad := func(id, size string) map[string]any {
		mods := allModules(nil, catalogIDs)
		for _, m := range mods {
			if m["id"] == id {
				m["size"] = size
			}
		}
		return map[string]any{
			"preset": "custom", "modules": mods, "pinned_device_ids": []string{}, "theme": "system", "density": "comfortable",
		}
	}
	for name, body := range map[string]map[string]any{
		"size the module does not offer": bad("platform-mix", "large"),
		"fleet pulse has no large size":  bad("fleet-pulse", "large"),
		"unknown size":                   bad("fleet-pulse", "huge"),
	} {
		t.Run(name, func(t *testing.T) {
			requireError(t, c.do(http.MethodPut, apiPrefix+"/me/preferences", body), http.StatusBadRequest, codeBadRequest)
		})
	}
}

func TestPreferencesPaletteKeptWhenOmitted(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "admin")
	base := map[string]any{
		"preset": "business", "modules": allModules(nil, catalogIDs), "pinned_device_ids": []string{},
		"theme": "system", "density": "comfortable",
	}
	withPalette := func(palette string) map[string]any {
		m := map[string]any{}
		for k, v := range base {
			m[k] = v
		}
		m["palette"] = palette
		return m
	}
	first := c.ok(http.MethodPut, apiPrefix+"/me/preferences", withPalette("moss"))
	require.Equal(t, "moss", first["palette"])
	got := c.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)
	require.Equal(t, "moss", got["palette"])
	kept := c.ok(http.MethodPut, apiPrefix+"/me/preferences", base)
	require.Equal(t, "moss", kept["palette"])
	fresh, _ := e.signedIn("bob", "admin")
	require.Equal(t, "default", fresh.ok(http.MethodPut, apiPrefix+"/me/preferences", base)["palette"])
}

func TestPreferencesRoundTrip(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("alice", "admin")
	d1 := e.enroll(srv, "100000001")
	d2 := e.enroll(srv, "100000002")
	for _, id := range []uuid.UUID{d1, d2} {
		_, err := e.d.Pool.Exec(context.Background(), `UPDATE devices SET state = 'approved' WHERE id = $1`, id)
		require.NoError(t, err)
	}

	order := append([]string{"platform-mix"}, catalogIDs[:9]...)
	order = append(order, "admin-activity")
	req := map[string]any{
		"preset":            "custom",
		"modules":           allModules(map[string]bool{"platform-mix": true, "fleet-pulse": true}, order),
		"pinned_device_ids": []string{d2.String(), d1.String()},
		"theme":             "dark",
		"palette":           "violet",
		"density":           "compact",
	}

	put := c.ok(http.MethodPut, apiPrefix+"/me/preferences", req)
	got := c.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)
	require.Equal(t, put, got)
	require.Equal(t, "custom", got["preset"])
	require.Equal(t, "dark", got["theme"])
	require.Equal(t, "violet", got["palette"])
	require.Equal(t, "compact", got["density"])
	require.Equal(t, []any{d2.String(), d1.String()}, got["pinned_device_ids"], "stored order kept")
	ids, enabled := moduleList(t, got)
	require.Equal(t, order, ids)
	require.True(t, enabled[0])

	// Devices that stop being approved, or vanish, are dropped on read.
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE devices SET state = 'archived' WHERE id = $1`, d2)
	require.NoError(t, err)
	got = c.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)
	require.Equal(t, []any{d1.String()}, got["pinned_device_ids"])
	_, err = e.d.Pool.Exec(context.Background(), `DELETE FROM devices WHERE id = $1`, d1)
	require.NoError(t, err)
	got = c.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)
	require.Equal(t, []any{}, got["pinned_device_ids"])

	// A PUT may pin unknown IDs; the response drops them like GET does.
	req["pinned_device_ids"] = []string{uuid.NewString()}
	put = c.ok(http.MethodPut, apiPrefix+"/me/preferences", req)
	require.Equal(t, []any{}, put["pinned_device_ids"])
}

func TestPreferencesValidation(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "admin")

	valid := func() map[string]any {
		return map[string]any{
			"preset":            "business",
			"modules":           allModules(map[string]bool{"fleet-pulse": true}, catalogIDs),
			"pinned_device_ids": []string{},
			"theme":             "system",
			"density":           "comfortable",
		}
	}
	c.ok(http.MethodPut, apiPrefix+"/me/preferences", valid())

	mut := func(f func(m map[string]any)) map[string]any {
		m := valid()
		f(m)
		return m
	}
	pins := func(n int) []string {
		out := make([]string, n)
		for i := range out {
			out[i] = uuid.NewString()
		}
		return out
	}
	dup := uuid.NewString()
	cases := map[string]map[string]any{
		"bad palette":        mut(func(m map[string]any) { m["palette"] = "neon" }),
		"empty palette":      mut(func(m map[string]any) { m["palette"] = "" }),
		"non-string palette": mut(func(m map[string]any) { m["palette"] = 7 }),
		"unknown module": mut(func(m map[string]any) {
			m["modules"] = append(allModules(nil, catalogIDs[:10]), map[string]any{"id": "nope", "enabled": true})
		}),
		"duplicate module": mut(func(m map[string]any) {
			m["modules"] = append(allModules(nil, catalogIDs[:10]), map[string]any{"id": "fleet-pulse", "enabled": true})
		}),
		"25 pins":       mut(func(m map[string]any) { m["pinned_device_ids"] = pins(25) }),
		"duplicate pin": mut(func(m map[string]any) { m["pinned_device_ids"] = []string{dup, dup} }),
		"bad pin":       mut(func(m map[string]any) { m["pinned_device_ids"] = []string{"nope"} }),
		"bad theme":     mut(func(m map[string]any) { m["theme"] = "blue" }),
		"bad density":   mut(func(m map[string]any) { m["density"] = "tight" }),
		"bad preset":    mut(func(m map[string]any) { m["preset"] = "gaming" }),
		"missing theme": mut(func(m map[string]any) { delete(m, "theme") }),
		"unknown field": mut(func(m map[string]any) { m["extra"] = 1 }),
		"null pins":     mut(func(m map[string]any) { m["pinned_device_ids"] = nil }),
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			requireError(t, c.do(http.MethodPut, apiPrefix+"/me/preferences", body), http.StatusBadRequest, codeBadRequest)
		})
	}
	for _, palette := range []any{"neon", "", 7} {
		res := c.do(http.MethodPut, apiPrefix+"/me/preferences", mut(func(m map[string]any) { m["palette"] = palette }))
		require.Equal(t, http.StatusBadRequest, res.Code)
		require.Contains(t, res.Body.String(), `"code":"bad_request"`)
		require.Contains(t, res.Body.String(), "palette must be default, graphite, ocean, violet, moss or sandstone")
	}

	// Size is the only thing wrong with the oversize body: it is valid JSON
	// padded with insignificant spaces.
	padded := func(n int) rawBody {
		raw, err := json.Marshal(valid())
		require.NoError(t, err)
		require.Less(t, len(raw), n)
		return rawBody(append(raw[:len(raw)-1], append(bytes.Repeat([]byte(" "), n-len(raw)), '}')...))
	}
	t.Run("16 KiB body is accepted", func(t *testing.T) {
		body := padded(16 << 10)
		require.Len(t, body, 16<<10)
		require.Equal(t, http.StatusOK, c.do(http.MethodPut, apiPrefix+"/me/preferences", body).Code)
	})
	t.Run("16 KiB + 1 body is rejected", func(t *testing.T) {
		body := padded(16<<10 + 1)
		require.Len(t, body, 16<<10+1)
		requireError(t, c.do(http.MethodPut, apiPrefix+"/me/preferences", body), http.StatusBadRequest, codeBadRequest)
	})

	// Nothing invalid was stored.
	got := c.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)
	require.Equal(t, "system", got["theme"])
}

func TestPreferencesForwardCompatible(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, id := e.signedIn("alice", "admin")
	// Stored before sizes existed (live-sessions), and with a size that is no
	// longer offered (fleet-pulse): both get the module's default.
	raw := `{"preset":"custom","modules":[{"id":"retired-module","enabled":true},{"id":"live-sessions","enabled":true},{"id":"fleet-pulse","enabled":false,"size":"gigantic"}],` +
		`"pinned_device_ids":[],"theme":"light","density":"compact"}`
	_, err := e.d.Pool.Exec(context.Background(),
		`INSERT INTO user_preferences (user_id, prefs, updated_at) VALUES ($1, $2::jsonb, now())`, id, raw)
	require.NoError(t, err)

	got := c.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)
	ids, enabled := moduleList(t, got)
	require.NotContains(t, ids, "retired-module")
	require.Equal(t, []string{
		"live-sessions", "fleet-pulse", "quick-connect", "approval-queue", "needs-attention", "activity-trend",
		"fleet-overview", "recent-sessions", "session-analytics", "platform-mix", "admin-activity",
	}, ids)
	require.Equal(t, []bool{true, false}, enabled[:2])
	for _, en := range enabled[2:] {
		require.False(t, en, "modules new to the catalog arrive disabled")
	}
	sizes := moduleSizes(t, got)
	require.Equal(t, "medium", sizes["live-sessions"])
	require.Equal(t, "medium", sizes["fleet-pulse"])
	require.Equal(t, "light", got["theme"])
	require.Equal(t, "compact", got["density"])
	require.Equal(t, "default", got["palette"])
	require.Equal(t, float64(5), got["toast_seconds"], "stored blobs without a toast duration use the default")
	_, err = e.d.Pool.Exec(context.Background(), `UPDATE user_preferences SET prefs = jsonb_set(prefs, '{palette}', '"neon"') WHERE user_id = $1`, id)
	require.NoError(t, err)
	got = c.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)
	require.Equal(t, "default", got["palette"])
	_, err = e.d.Pool.Exec(context.Background(), `UPDATE user_preferences SET prefs = jsonb_set(prefs, '{toast_seconds}', '7') WHERE user_id = $1`, id)
	require.NoError(t, err)
	got = c.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)
	require.Equal(t, float64(5), got["toast_seconds"])
}

func TestPreferencesPerUser(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	alice, _ := e.signedIn("alice", "admin")
	bob, _ := e.signedIn("bob", "admin")

	alice.ok(http.MethodPut, apiPrefix+"/me/preferences", map[string]any{
		"preset": "wall", "modules": allModules(map[string]bool{"fleet-pulse": true}, catalogIDs),
		"pinned_device_ids": []string{}, "theme": "dark", "density": "compact",
	})
	require.Equal(t, "dark", alice.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)["theme"])
	b := bob.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)
	require.Equal(t, "business", b["preset"])
	require.Equal(t, "system", b["theme"])

	// Saving again replaces, and adds no audit event.
	var before, after int
	require.NoError(t, e.d.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events`).Scan(&before))
	alice.ok(http.MethodPut, apiPrefix+"/me/preferences", map[string]any{
		"preset": "wall", "modules": allModules(nil, catalogIDs),
		"pinned_device_ids": []string{}, "theme": "light", "density": "compact",
	})
	require.NoError(t, e.d.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events`).Scan(&after))
	require.Equal(t, before, after)
	require.Equal(t, "light", alice.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)["theme"])
}
