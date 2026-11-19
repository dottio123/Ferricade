package adminapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"go.yaml.in/yaml/v3"
)

func TestUserRouteTableCoversOpenAPI(t *testing.T) {
	var spec struct {
		Paths map[string]map[string]any `yaml:"paths"`
	}
	require.NoError(t, yaml.Unmarshal(openapiYAML, &spec))
	outcomes := map[string]string{}
	add := func(outcome, operations string) {
		for _, line := range strings.Split(strings.TrimSpace(operations), "\n") {
			fields := strings.Fields(line)
			require.Len(t, fields, 2, line)
			key := fields[0] + " " + fields[1]
			require.Empty(t, outcomes[key], "duplicate route outcome: %s", key)
			outcomes[key] = outcome
		}
	}
	add("own", `
POST /admin/api/v1/auth/login
GET /admin/api/v1/auth/oidc
GET /admin/api/v1/auth/oidc/start
GET /admin/api/v1/auth/oidc/callback
POST /admin/api/v1/auth/logout
GET /admin/api/v1/auth/me
POST /admin/api/v1/auth/totp
POST /admin/api/v1/auth/totp/enroll
POST /admin/api/v1/auth/totp/enroll/verify
POST /admin/api/v1/auth/password
GET /admin/api/v1/users/{id}/avatar
GET /admin/api/v1/events
GET /admin/api/v1/me/preferences
PUT /admin/api/v1/me/preferences
GET /admin/api/v1/settings/dashboard
GET /setup/status
POST /setup/owner
POST /setup/owner/totp
POST /setup/owner/totp/verify
POST /setup/server
POST /setup/complete`)
	add("notFoundForUngranted", `
GET /admin/api/v1/devices/{id}
GET /admin/api/v1/devices/{id}/policy
GET /admin/api/v1/devices/{id}/connect`)
	add("scoped", `
GET /admin/api/v1/devices
GET /admin/api/v1/sessions
GET /admin/api/v1/sessions/stats
GET /admin/api/v1/audit
GET /admin/api/v1/stats/summary
GET /admin/api/v1/stats/fleet-map
GET /admin/api/v1/server/health
GET /admin/api/v1/dashboard/catalog
GET /admin/api/v1/groups
GET /admin/api/v1/tags`)
	add("forbidden", `
POST /admin/api/v1/devices/auto-sort/preview
POST /admin/api/v1/devices/auto-sort
GET /admin/api/v1/group-rules
POST /admin/api/v1/groups/{id}/rules
DELETE /admin/api/v1/groups/{id}/rules/{rule_id}
POST /admin/api/v1/groups/{id}/rules/preview
GET /admin/api/v1/policies
POST /admin/api/v1/policies
GET /admin/api/v1/policies/{id}
PATCH /admin/api/v1/policies/{id}
DELETE /admin/api/v1/policies/{id}
GET /admin/api/v1/settings/policy-push
PUT /admin/api/v1/settings/policy-push
PUT /admin/api/v1/settings/id-allow-list
GET /admin/api/v1/settings/id-allow-list
GET /admin/api/v1/groups/{id}/id-allow-list
PUT /admin/api/v1/groups/{id}/id-allow-list
GET /admin/api/v1/devices/{id}/id-allow-list
PUT /admin/api/v1/devices/{id}/id-allow-list
GET /admin/api/v1/settings/sessions
PUT /admin/api/v1/settings/sessions
GET /admin/api/v1/settings/log-export
PUT /admin/api/v1/settings/log-export
POST /admin/api/v1/settings/log-export/test
PUT /admin/api/v1/groups/{id}/policy
GET /admin/api/v1/settings/oidc
PATCH /admin/api/v1/settings/oidc
POST /admin/api/v1/settings/oidc/test
GET /admin/api/v1/server/client-config
GET /admin/api/v1/deployment/profile
PUT /admin/api/v1/deployment/profile
POST /admin/api/v1/deployment/script
POST /admin/api/v1/sessions/{id}/disconnect
GET /admin/api/v1/server
PATCH /admin/api/v1/server
POST /admin/api/v1/server/check
GET /admin/api/v1/stats/history
PUT /admin/api/v1/settings/dashboard
PATCH /admin/api/v1/devices/{id}
DELETE /admin/api/v1/devices/{id}
POST /admin/api/v1/devices/{id}/approve
POST /admin/api/v1/devices/{id}/reject
POST /admin/api/v1/devices/{id}/reopen
POST /admin/api/v1/devices/{id}/archive
POST /admin/api/v1/devices/{id}/restore
POST /admin/api/v1/devices/{id}/alerts/{alert_id}/resolve
POST /admin/api/v1/devices/{id}/access-window
POST /admin/api/v1/devices/{id}/access-window/close
POST /admin/api/v1/groups
PATCH /admin/api/v1/groups/{id}
POST /admin/api/v1/groups/{id}/move
DELETE /admin/api/v1/groups/{id}
POST /admin/api/v1/tags
PATCH /admin/api/v1/tags/{id}
DELETE /admin/api/v1/tags/{id}
GET /admin/api/v1/users
POST /admin/api/v1/users
PATCH /admin/api/v1/users/{id}
POST /admin/api/v1/users/{id}/reset-totp
POST /admin/api/v1/users/{id}/password
DELETE /admin/api/v1/users/{id}/oidc
GET /admin/api/v1/users/{id}/grants
PUT /admin/api/v1/users/{id}/grants`)
	methods := map[string]bool{"get": true, "put": true, "post": true, "delete": true, "patch": true}
	for path, ops := range spec.Paths {
		for method := range ops {
			if methods[method] {
				key := strings.ToUpper(method) + " " + path
				require.Contains(t, outcomes, key, "new operation needs an explicit User outcome")
			}
		}
	}
	for key := range outcomes {
		method, path, _ := strings.Cut(key, " ")
		require.Contains(t, spec.Paths[path], strings.ToLower(method), "outcome has no operation")
	}

	e := newEnv(t)
	e.markSetupComplete()
	viewer, _ := e.signedIn("viewer", "user")
	for key, outcome := range outcomes {
		method, path, _ := strings.Cut(key, " ")
		path = strings.ReplaceAll(path, "{id}", uuid.NewString())
		path = strings.ReplaceAll(path, "{alert_id}", uuid.NewString())
		if key == "POST /admin/api/v1/auth/logout" || key == "GET /admin/api/v1/events" {
			continue
		}
		_, rec := viewer.send(method, path, nil)
		switch outcome {
		case "forbidden":
			requireError(t, rec, http.StatusForbidden, codeForbidden)
		case "notFoundForUngranted":
			requireError(t, rec, http.StatusNotFound, codeNotFound)
		case "scoped":
			require.Equal(t, http.StatusOK, rec.Code, key+": "+rec.Body.String())
		case "own":
			if rec.Code == http.StatusForbidden {
				require.NotEqual(t, codeForbidden, decodeBody(t, rec)["error"].(map[string]any)["code"], key)
			}
		}
	}
	require.Equal(t, http.StatusNoContent, viewer.do(http.MethodPost, apiPrefix+"/auth/logout", nil).Code)
	viewer, _ = e.signedIn("viewer2", "user")
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, apiPrefix+"/events", nil)
	req.Header.Set("Origin", publicURL)
	req.AddCookie(viewer.cookie)
	rec := &eventHeaderRecorder{ResponseRecorder: httptest.NewRecorder(), ready: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		e.h.ServeHTTP(rec, req)
		close(done)
	}()
	select {
	case <-rec.ready:
	case <-time.After(time.Second):
		t.Fatal("event stream did not write headers")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("event stream did not close after cancellation")
	}
	require.Equal(t, http.StatusOK, rec.Code)
}

type eventHeaderRecorder struct {
	*httptest.ResponseRecorder
	ready chan struct{}
	once  sync.Once
}

func (w *eventHeaderRecorder) WriteHeader(status int) {
	w.ResponseRecorder.WriteHeader(status)
	w.once.Do(func() { close(w.ready) })
}

func TestUserRouteGuard(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	user, _ := e.signedIn("viewer", "user")

	for _, path := range []string{"/server", "/server/client-config", "/stats/history", "/users"} {
		t.Run(path, func(t *testing.T) {
			rec := user.do(http.MethodGet, apiPrefix+path, nil)
			requireError(t, rec, http.StatusForbidden, codeForbidden)
		})
	}
}

func TestUserScopedFleet(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("alice", "owner")
	viewer, viewerID := e.signedIn("viewer", "user")
	root := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Granted"})["id"].(string)
	child := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Child", "parent_id": root})["id"].(string)
	hiddenGroup := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Hidden"})["id"].(string)
	visibleTag := owner.ok(http.MethodPost, apiPrefix+"/tags", map[string]any{"name": "visible", "color": 1})["id"].(string)
	hiddenTag := owner.ok(http.MethodPost, apiPrefix+"/tags", map[string]any{"name": "hidden", "color": 2})["id"].(string)
	type seeded struct {
		rid, group, tag, state string
		id                     uuid.UUID
	}
	devices := []seeded{
		{rid: "900000001", group: root, state: "approved"},
		{rid: "900000002", group: child, tag: visibleTag, state: "approved"},
		{rid: "900000003", state: "approved"},
		{rid: "900000004", group: hiddenGroup, tag: hiddenTag, state: "approved"},
		{rid: "900000005", group: root, state: "pending"},
		{rid: "900000006", group: root, state: "archived"},
	}
	for i := range devices {
		d := &devices[i]
		d.id = e.enroll(srv, d.rid)
		if d.state != "pending" {
			owner.ok(http.MethodPost, apiPrefix+"/devices/"+d.id.String()+"/approve", nil)
		}
		patch := map[string]any{}
		if d.group != "" {
			patch["group_id"] = d.group
		}
		if d.tag != "" {
			patch["tag_ids"] = []string{d.tag}
		}
		if len(patch) > 0 {
			owner.ok(http.MethodPatch, apiPrefix+"/devices/"+d.id.String(), patch)
		}
		if d.state == "archived" {
			owner.ok(http.MethodPost, apiPrefix+"/devices/"+d.id.String()+"/archive", nil)
		}
	}
	owner.ok(http.MethodPut, apiPrefix+"/users/"+viewerID.String()+"/grants", map[string]any{
		"group_ids": []string{root}, "device_ids": []string{devices[2].id.String()},
	})
	e.clock.Add(time.Minute)
	now := e.clock.Now()
	e.session(srv, devices[1].rid, 1, intp(0), now.Add(-time.Hour), time.Minute)
	e.session(srv, devices[3].rid, 2, intp(0), now.Add(-time.Hour), time.Minute)
	visible := map[string]bool{}
	for _, d := range devices[:3] {
		visible[d.id.String()] = true
	}
	list := items(t, viewer.ok(http.MethodGet, apiPrefix+"/devices", nil))
	require.Len(t, list, 3)
	for _, d := range list {
		require.True(t, visible[d["id"].(string)])
		require.Nil(t, d["approved_by"])
	}
	for _, state := range []string{"pending", "rejected", "archived"} {
		require.Empty(t, items(t, viewer.ok(http.MethodGet, apiPrefix+"/devices?state="+state, nil)))
	}
	for _, d := range devices[:3] {
		got := viewer.ok(http.MethodGet, apiPrefix+"/devices/"+d.id.String(), nil)
		require.Equal(t, d.id.String(), got["id"])
		require.Nil(t, got["approved_by"])
	}
	unknown := uuid.NewString()
	for _, path := range []string{"/devices/" + devices[3].id.String(), "/devices/" + devices[4].id.String(), "/devices/" + devices[5].id.String(), "/devices/" + unknown} {
		rec := viewer.do(http.MethodGet, apiPrefix+path, nil)
		requireError(t, rec, http.StatusNotFound, codeNotFound)
		require.JSONEq(t, `{"error":{"code":"not_found","message":"not found"}}`, rec.Body.String())
	}
	for _, id := range []string{devices[3].id.String(), unknown} {
		requireError(t, viewer.do(http.MethodGet, apiPrefix+"/devices/"+id+"/connect", nil), http.StatusNotFound, codeNotFound)
	}
	viewer.ok(http.MethodGet, apiPrefix+"/devices/"+devices[1].id.String()+"/connect", nil)
	require.Equal(t, &viewerID, e.auditEntries("device.connect_link")[0].ActorUserID)
	groups := items(t, viewer.ok(http.MethodGet, apiPrefix+"/groups", nil))
	require.Len(t, groups, 1)
	require.Equal(t, root, groups[0]["id"])
	require.Equal(t, child, groups[0]["children"].([]any)[0].(map[string]any)["id"])
	tags := items(t, viewer.ok(http.MethodGet, apiPrefix+"/tags", nil))
	require.Len(t, tags, 1)
	require.Equal(t, visibleTag, tags[0]["id"])
	sessions := items(t, viewer.ok(http.MethodGet, apiPrefix+"/sessions", nil))
	require.Len(t, sessions, 1)
	require.Equal(t, devices[1].id.String(), sessions[0]["device_id"])
	require.Empty(t, items(t, viewer.ok(http.MethodGet, apiPrefix+"/sessions?device_id="+devices[3].id.String(), nil)))
	st := viewer.ok(http.MethodGet, apiPrefix+"/sessions/stats", nil)
	require.Len(t, st["top_devices"], 1)
	require.Equal(t, devices[1].id.String(), st["top_devices"].([]any)[0].(map[string]any)["device_id"])
	var sessionCount float64
	for _, day := range st["per_day"].([]any) {
		sessionCount += day.(map[string]any)["count"].(float64)
	}
	require.Equal(t, float64(1), sessionCount)
	summary := viewer.ok(http.MethodGet, apiPrefix+"/stats/summary", nil)
	require.Equal(t, map[string]any{"approved": float64(3), "pending": float64(0), "rejected": float64(0), "archived": float64(0), "online": float64(0)}, summary["devices"])
	for _, entry := range items(t, viewer.ok(http.MethodGet, apiPrefix+"/audit?actor="+uuid.NewString(), nil)) {
		require.Equal(t, viewerID.String(), entry["actor_user_id"])
	}
	catalog := viewer.ok(http.MethodGet, apiPrefix+"/dashboard/catalog", nil)
	require.Len(t, catalog["modules"], 8)
	for _, p := range catalog["presets"].([]any) {
		require.NotEqual(t, "wall", p.(map[string]any)["id"])
	}
	requireError(t, viewer.do(http.MethodGet, apiPrefix+"/users/"+uuid.NewString()+"/avatar", nil), http.StatusNotFound, codeNotFound)
}
