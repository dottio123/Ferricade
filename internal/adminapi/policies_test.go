package adminapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/events"
	"github.com/dottio123/ferricade/internal/policies"
)

func TestPolicyAPI(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, ownerID := e.signedIn("owner", "owner")
	admin, adminID := e.signedIn("admin", "admin")
	requireError(t, admin.do(http.MethodPut, apiPrefix+"/settings/policy-push", map[string]any{"enabled": true}), http.StatusForbidden, codeForbidden)
	base := apiPrefix + "/policies"
	list := items(t, owner.ok(http.MethodGet, base, nil))
	require.Len(t, list, 1)
	defaultID := list[0]["id"].(string)
	require.Equal(t, true, list[0]["is_default"])
	require.Nil(t, list[0]["updated_by"])
	require.NotEmpty(t, list[0]["updated_at"])
	settings := policies.DefaultSettings()
	settings["enable-file-transfer"] = "N"
	contradiction := policies.Settings{"approve-mode": "password-click", "verification-method": "use-both-passwords", "enable-file-transfer": "N", "access-mode": "full"}
	response := admin.do(http.MethodPost, base, map[string]any{"name": "Contradiction", "settings": contradiction})
	requireError(t, response, http.StatusBadRequest, codeBadRequest)
	require.Equal(t, "access-mode: must be custom when individual permissions are managed", decodeBody(t, response)["error"].(map[string]any)["message"])
	created := admin.ok(http.MethodPost, base, map[string]any{"name": "Office", "settings": settings})
	id := created["id"].(string)
	require.Equal(t, false, created["is_default"])
	require.Equal(t, "N", created["settings"].(map[string]any)["enable-file-transfer"])
	require.Equal(t, adminID.String(), created["updated_by"].(map[string]any)["id"])
	require.Equal(t, id, owner.ok(http.MethodGet, base+"/"+id, nil)["id"])
	require.Len(t, items(t, owner.ok(http.MethodGet, base, nil)), 2)
	renamed := admin.ok(http.MethodPatch, base+"/"+id, map[string]any{"name": "Office 2"})
	require.Equal(t, "N", renamed["settings"].(map[string]any)["enable-file-transfer"])
	require.Equal(t, "Office 2", renamed["name"])
	requireError(t, admin.do(http.MethodPost, base, map[string]any{"name": "Office 2", "settings": settings}), http.StatusConflict, codeNameTaken)
	bad := admin.do(http.MethodPost, base, map[string]any{"name": "Bad", "settings": map[string]string{"custom-rendezvous-server": "x"}})
	requireError(t, bad, http.StatusBadRequest, codeBadRequest)
	require.Equal(t, "custom-rendezvous-server: not a catalog setting", decodeBody(t, bad)["error"].(map[string]any)["message"])
	requireError(t, admin.do(http.MethodPost, base, map[string]any{"name": "missing"}), http.StatusBadRequest, codeBadRequest)
	requireError(t, admin.do(http.MethodPatch, base+"/"+id, map[string]any{}), http.StatusBadRequest, codeBadRequest)
	requireError(t, admin.do(http.MethodPatch, base+"/"+defaultID, map[string]any{"name": "Changed"}), http.StatusConflict, codeDefaultPolicy)
	requireError(t, admin.do(http.MethodDelete, base+"/"+defaultID, nil), http.StatusConflict, codeDefaultPolicy)
	unknown := uuid.NewString()
	requireError(t, owner.do(http.MethodGet, base+"/"+unknown, nil), http.StatusNotFound, codeNotFound)
	requireError(t, owner.do(http.MethodPatch, base+"/"+unknown, map[string]any{"name": "new"}), http.StatusNotFound, codeNotFound)
	requireError(t, owner.do(http.MethodDelete, base+"/"+unknown, nil), http.StatusNotFound, codeNotFound)
	group := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Assigned"})
	groupID := group["id"].(string)
	assigned := owner.ok(http.MethodPut, apiPrefix+"/groups/"+groupID+"/policy", map[string]any{"policy_id": id})
	require.Equal(t, id, assigned["policy_id"])
	require.Equal(t, id, assigned["effective_policy_id"])
	require.Len(t, e.auditEntries("group.policy_changed"), 1)
	requireError(t, admin.do(http.MethodDelete, base+"/"+id, nil), http.StatusConflict, codeInUse)
	cleared := owner.ok(http.MethodPut, apiPrefix+"/groups/"+groupID+"/policy", map[string]any{"policy_id": nil})
	require.Nil(t, cleared["policy_id"])
	require.Equal(t, defaultID, cleared["effective_policy_id"])
	requireError(t, admin.do(http.MethodPut, apiPrefix+"/groups/"+groupID+"/policy", map[string]any{"policy_id": unknown}), http.StatusNotFound, codeNotFound)
	requireError(t, admin.do(http.MethodPut, apiPrefix+"/groups/"+unknown+"/policy", map[string]any{"policy_id": nil}), http.StatusNotFound, codeNotFound)
	requireError(t, admin.do(http.MethodPut, apiPrefix+"/groups/"+groupID+"/policy", map[string]any{}), http.StatusBadRequest, codeBadRequest)
	require.Equal(t, http.StatusNoContent, admin.do(http.MethodDelete, base+"/"+id, nil).Code)
	requireError(t, owner.do(http.MethodGet, base+"/"+id, nil), http.StatusNotFound, codeNotFound)
	push := admin.ok(http.MethodGet, apiPrefix+"/settings/policy-push", nil)
	require.Equal(t, false, push["enabled"])
	require.NotEmpty(t, push["updated_at"])
	requireError(t, owner.do(http.MethodPut, apiPrefix+"/settings/policy-push", map[string]any{}), http.StatusBadRequest, codeBadRequest)
	push = owner.ok(http.MethodPut, apiPrefix+"/settings/policy-push", map[string]any{"enabled": true})
	require.Equal(t, true, push["enabled"])
	require.Equal(t, ownerID.String(), push["updated_by"].(map[string]any)["id"])
	require.Len(t, e.auditEntries("policy_push.enabled"), 1)
	require.Equal(t, true, admin.ok(http.MethodGet, apiPrefix+"/settings/policy-push", nil)["enabled"])
}

func TestDevicePolicyStatusScope(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("policy-owner", "owner")
	viewer, viewerID := e.signedIn("policy-viewer", "user")
	visible := e.enroll(srv, "policy-visible")
	hidden := e.enroll(srv, "policy-hidden")
	for _, id := range []uuid.UUID{visible, hidden} {
		owner.ok(http.MethodPost, apiPrefix+"/devices/"+id.String()+"/approve", nil)
	}
	group := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Private policy group"})
	policy := owner.ok(http.MethodPost, apiPrefix+"/policies", map[string]any{"name": "Private policy", "settings": map[string]string{"approve-mode": "click", "verification-method": "use-both-passwords"}})
	owner.ok(http.MethodPut, apiPrefix+"/groups/"+group["id"].(string)+"/policy", map[string]any{"policy_id": policy["id"]})
	owner.ok(http.MethodPatch, apiPrefix+"/devices/"+visible.String(), map[string]any{"group_id": group["id"]})
	owner.ok(http.MethodPut, apiPrefix+"/settings/policy-push", map[string]any{"enabled": true})
	window := owner.ok(http.MethodPost, apiPrefix+"/devices/"+visible.String()+"/access-window", map[string]any{"duration_minutes": nil, "disconnect_on_close": false})
	owner.ok(http.MethodPut, apiPrefix+"/users/"+viewerID.String()+"/grants", map[string]any{"group_ids": []string{}, "device_ids": []string{visible.String()}})
	ownerStatus := owner.ok(http.MethodGet, apiPrefix+"/devices/"+visible.String()+"/policy", nil)
	require.Equal(t, group["id"], ownerStatus["source_group"].(map[string]any)["id"])
	require.Equal(t, window["opened_by"], ownerStatus["window"].(map[string]any)["opened_by"])
	got := viewer.ok(http.MethodGet, apiPrefix+"/devices/"+visible.String()+"/policy", nil)
	require.Equal(t, true, got["push_enabled"])
	require.Nil(t, got["source_group"])
	require.Nil(t, got["window"].(map[string]any)["opened_by"])
	require.Nil(t, got["close_unconfirmed_since"])
	require.NotEmpty(t, got["policy"])
	requireError(t, viewer.do(http.MethodGet, apiPrefix+"/devices/"+hidden.String()+"/policy", nil), http.StatusNotFound, codeNotFound)
	requireError(t, owner.do(http.MethodGet, apiPrefix+"/devices/"+uuid.NewString()+"/policy", nil), http.StatusNotFound, codeNotFound)
}

func TestConnectAccessPolicy(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("connect-policy-owner", "owner")
	viewer, viewerID := e.signedIn("connect-policy-viewer", "user")
	id := e.enroll(srv, "connect-policy-device")
	base := apiPrefix + "/devices/" + id.String()
	owner.ok(http.MethodPost, base+"/approve", nil)
	owner.ok(http.MethodPut, apiPrefix+"/users/"+viewerID.String()+"/grants", map[string]any{"group_ids": []string{}, "device_ids": []string{id.String()}})
	connect := base + "/connect"
	for _, c := range []*client{owner, viewer} {
		require.Equal(t, "unrestricted", c.ok(http.MethodGet, base+"/policy", nil)["connect"])
		c.ok(http.MethodGet, connect, nil)
	}
	owner.ok(http.MethodPut, apiPrefix+"/settings/policy-push", map[string]any{"enabled": true})
	defaultPolicy := items(t, owner.ok(http.MethodGet, apiPrefix+"/policies", nil))[0]
	setMode := func(mode string) {
		owner.ok(http.MethodPatch, apiPrefix+"/policies/"+defaultPolicy["id"].(string), map[string]any{"settings": map[string]string{"approve-mode": mode, "verification-method": "use-temporary-password"}})
	}
	setMode("password")
	before := len(e.auditEntries("device.connect_link"))
	for _, c := range []*client{owner, viewer} {
		require.Equal(t, "locked", c.ok(http.MethodGet, base+"/policy", nil)["connect"])
		r := c.do(http.MethodGet, connect, nil)
		requireError(t, r, http.StatusConflict, "access_locked")
		require.Equal(t, "Locked by policy. Allow access first.", decodeBody(t, r)["error"].(map[string]any)["message"])
	}
	require.Len(t, e.auditEntries("device.connect_link"), before)
	owner.ok(http.MethodPost, base+"/access-window", map[string]any{"duration_minutes": nil, "disconnect_on_close": false})
	for _, c := range []*client{owner, viewer} {
		require.Equal(t, "window", c.ok(http.MethodGet, base+"/policy", nil)["connect"])
		c.ok(http.MethodGet, connect, nil)
	}
	require.Equal(t, http.StatusNoContent, owner.do(http.MethodPost, base+"/access-window/close", map[string]any{"disconnect": false}).Code)
	require.Equal(t, "locked", viewer.ok(http.MethodGet, base+"/policy", nil)["connect"])
	requireError(t, viewer.do(http.MethodGet, connect, nil), http.StatusConflict, "access_locked")
	setMode("click")
	for _, c := range []*client{owner, viewer} {
		require.Equal(t, "attended", c.ok(http.MethodGet, base+"/policy", nil)["connect"])
		c.ok(http.MethodGet, connect, nil)
	}
}

func TestPushOffBlockedWhileWindowOpenAPI(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("push-window-owner", "owner")
	id := e.enroll(srv, "push-window")
	base := apiPrefix + "/devices/" + id.String()
	owner.ok(http.MethodPost, base+"/approve", nil)
	owner.ok(http.MethodPut, apiPrefix+"/settings/policy-push", map[string]any{"enabled": true})
	def := items(t, owner.ok(http.MethodGet, apiPrefix+"/policies", nil))[0]
	owner.ok(http.MethodPatch, apiPrefix+"/policies/"+def["id"].(string), map[string]any{"settings": map[string]string{"approve-mode": "click", "verification-method": "use-both-passwords"}})
	owner.ok(http.MethodPost, base+"/access-window", map[string]any{"duration_minutes": nil, "disconnect_on_close": false})
	requireError(t, owner.do(http.MethodPut, apiPrefix+"/settings/policy-push", map[string]any{"enabled": false}), http.StatusConflict, codeWindowOpen)
	require.Equal(t, http.StatusNoContent, owner.do(http.MethodPost, base+"/access-window/close", map[string]any{"disconnect": false}).Code)
	owner.ok(http.MethodPut, apiPrefix+"/settings/policy-push", map[string]any{"enabled": false})
}

func TestArchiveReopenDeleteBlockedWhileWindowOpen(t *testing.T) {
	for _, action := range []struct{ method, suffix string }{
		{http.MethodPost, "/archive"}, {http.MethodPost, "/reopen"}, {http.MethodDelete, ""},
	} {
		t.Run(action.method+action.suffix, func(t *testing.T) {
			e := newEnv(t)
			srv := e.markSetupComplete()
			owner, _ := e.signedIn("transition-window-owner", "owner")
			id := e.enroll(srv, "transition-window")
			base := apiPrefix + "/devices/" + id.String()
			owner.ok(http.MethodPost, base+"/approve", nil)
			owner.ok(http.MethodPut, apiPrefix+"/settings/policy-push", map[string]any{"enabled": true})
			def := items(t, owner.ok(http.MethodGet, apiPrefix+"/policies", nil))[0]
			owner.ok(http.MethodPatch, apiPrefix+"/policies/"+def["id"].(string), map[string]any{"settings": map[string]string{"approve-mode": "click", "verification-method": "use-both-passwords"}})
			owner.ok(http.MethodPost, base+"/access-window", map[string]any{"duration_minutes": nil, "disconnect_on_close": false})
			requireError(t, owner.do(action.method, base+action.suffix, nil), http.StatusConflict, codeWindowOpen)
			require.Equal(t, http.StatusNoContent, owner.do(http.MethodPost, base+"/access-window/close", map[string]any{"disconnect": false}).Code)
			require.Equal(t, map[string]int{http.MethodPost: http.StatusOK, http.MethodDelete: http.StatusNoContent}[action.method], owner.do(action.method, base+action.suffix, nil).Code)
		})
	}
}

func TestAccessWindowRoutesAndAlert(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("window-owner", "owner")
	admin, _ := e.signedIn("window-admin", "admin")
	id := e.enroll(srv, "window-api")
	base := apiPrefix + "/devices/" + id.String()
	open := base + "/access-window"
	closePath := open + "/close"
	body := map[string]any{"duration_minutes": 60, "disconnect_on_close": false}
	requireError(t, owner.do(http.MethodPost, apiPrefix+"/devices/"+uuid.NewString()+"/access-window", body), http.StatusNotFound, codeNotFound)
	requireError(t, owner.do(http.MethodPost, open, body), http.StatusConflict, codeBadTransition)
	owner.ok(http.MethodPost, base+"/approve", nil)
	requireError(t, owner.do(http.MethodPost, open, body), http.StatusConflict, codePushOff)
	owner.ok(http.MethodPut, apiPrefix+"/settings/policy-push", map[string]any{"enabled": true})
	requireError(t, owner.do(http.MethodPost, open, body), http.StatusConflict, codeAlwaysReachable)
	defaultPolicy := items(t, owner.ok(http.MethodGet, apiPrefix+"/policies", nil))[0]
	owner.ok(http.MethodPatch, apiPrefix+"/policies/"+defaultPolicy["id"].(string), map[string]any{"settings": map[string]string{"approve-mode": "click", "verification-method": "use-both-passwords"}})
	requireError(t, admin.do(http.MethodPost, open, map[string]any{"duration_minutes": 30, "disconnect_on_close": false}), http.StatusBadRequest, codeBadRequest)
	requireError(t, admin.do(http.MethodPost, open, map[string]any{"disconnect_on_close": false}), http.StatusBadRequest, codeBadRequest)
	requireError(t, admin.do(http.MethodPost, open, map[string]any{"duration_minutes": nil}), http.StatusBadRequest, codeBadRequest)
	window := admin.ok(http.MethodPost, open, body)
	require.NotEmpty(t, window["ends_at"])
	require.Equal(t, false, window["disconnect_on_close"])
	require.NotNil(t, window["opened_by"])
	requireError(t, admin.do(http.MethodPost, open, body), http.StatusConflict, codeWindowOpen)
	status := admin.ok(http.MethodGet, base+"/policy", nil)
	require.Equal(t, "pending", status["status"])
	require.Equal(t, window["id"], status["window"].(map[string]any)["id"])
	require.Equal(t, http.StatusNoContent, admin.do(http.MethodPost, closePath, map[string]any{"disconnect": false}).Code)
	requireError(t, admin.do(http.MethodPost, closePath, map[string]any{"disconnect": false}), http.StatusNotFound, codeNotFound)
	requireError(t, admin.do(http.MethodPost, closePath, map[string]any{}), http.StatusBadRequest, codeBadRequest)
	status = admin.ok(http.MethodGet, base+"/policy", nil)
	require.NotNil(t, status["close_unconfirmed_since"])
	require.Len(t, e.auditEntries("access_window.opened"), 1)
	require.Len(t, e.auditEntries("access_window.closed"), 1)
	closed := e.clock.Now()
	_, err := e.d.Pool.Exec(context.Background(), `INSERT INTO device_alerts(device_id,kind,details) VALUES($1,'access_window_unconfirmed',$2)`, id, `{"window_id":"`+window["id"].(string)+`","closed_at":"`+closed.Format(time.RFC3339)+`"}`)
	require.NoError(t, err)
	alert := admin.ok(http.MethodGet, base, nil)["open_alerts"].([]any)[0].(map[string]any)
	require.Equal(t, "access_window_unconfirmed", alert["kind"])
	require.Nil(t, alert["seen_uuid"])
	require.Nil(t, alert["ip"])
	require.NotNil(t, alert["window_closed_at"])
	resolve := base + "/alerts/" + alert["id"].(string) + "/resolve"
	requireError(t, admin.do(http.MethodPost, resolve, map[string]any{"action": "accept_new_uuid"}), http.StatusBadRequest, codeBadRequest)
	admin.ok(http.MethodPost, resolve, map[string]any{"action": "dismiss"})
	require.Empty(t, admin.ok(http.MethodGet, base, nil)["open_alerts"].([]any))
}

func TestOpeningAccessWindowEmitsDeviceUpdated(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 0))
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("window-event-owner", "owner")
	id := e.enroll(srv, "window-event")
	owner.ok(http.MethodPost, apiPrefix+"/devices/"+id.String()+"/approve", nil)
	owner.ok(http.MethodPut, apiPrefix+"/settings/policy-push", map[string]any{"enabled": true})
	defaultPolicy := items(t, owner.ok(http.MethodGet, apiPrefix+"/policies", nil))[0]
	owner.ok(http.MethodPatch, apiPrefix+"/policies/"+defaultPolicy["id"].(string), map[string]any{"settings": map[string]string{"approve-mode": "click", "verification-method": "use-both-passwords"}})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		events.Listen(ctx, e.d.Pool, hub, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	t.Cleanup(func() { cancel(); <-done })
	waitListening(t, e)
	stream := openStream(t, eventsServer(t, e, nil), owner)
	owner.ok(http.MethodPost, apiPrefix+"/devices/"+id.String()+"/access-window", map[string]any{"duration_minutes": nil, "disconnect_on_close": false})
	require.Contains(t, stream.waitFor(t, "event: device.updated", 2*time.Second), `"device_id":"`+id.String()+`"`)
}

func TestDeviceAlertChangesEmitDeviceUpdated(t *testing.T) {
	hub := events.NewHub()
	e := newEnv(t, withHub(hub, 0))
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("alert-event-owner", "owner")
	id := e.enroll(srv, "alert-event")
	owner.ok(http.MethodPost, apiPrefix+"/devices/"+id.String()+"/approve", nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		events.Listen(ctx, e.d.Pool, hub, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	t.Cleanup(func() { cancel(); <-done })
	waitListening(t, e)
	stream := openStream(t, eventsServer(t, e, nil), owner)
	var alertID uuid.UUID
	require.NoError(t, e.d.Pool.QueryRow(ctx, `INSERT INTO device_alerts(device_id,kind) VALUES($1,'uuid_mismatch') RETURNING id`, id).Scan(&alertID))
	require.Contains(t, stream.waitFor(t, "event: device.updated", 2*time.Second), `"device_id":"`+id.String()+`"`)
	_, err := e.d.Pool.Exec(ctx, `UPDATE device_alerts SET resolved_at=now() WHERE id=$1`, alertID)
	require.NoError(t, err)
	require.Contains(t, stream.waitFor(t, "event: device.updated", 2*time.Second), `"device_id":"`+id.String()+`"`)
}

func TestGroupPolicyInheritanceAcrossUserScope(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	viewer, viewerID := e.signedIn("viewer", "user")
	defaultID := items(t, owner.ok(http.MethodGet, apiPrefix+"/policies", nil))[0]["id"]
	p := owner.ok(http.MethodPost, apiPrefix+"/policies", map[string]any{"name": "Parent policy", "settings": policies.DefaultSettings()})
	policyID := p["id"].(string)
	root := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Hidden parent"})["id"].(string)
	child := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Visible child", "parent_id": root})["id"].(string)
	plain := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Plain"})["id"].(string)
	owner.ok(http.MethodPut, apiPrefix+"/groups/"+root+"/policy", map[string]any{"policy_id": policyID})
	groups := items(t, owner.ok(http.MethodGet, apiPrefix+"/groups", nil))
	require.Len(t, groups, 2)
	for _, group := range groups {
		if group["id"] == plain {
			require.Equal(t, defaultID, group["effective_policy_id"])
		}
		if group["id"] == root {
			require.Equal(t, policyID, group["effective_policy_id"])
			children := group["children"].([]any)
			require.Equal(t, policyID, children[0].(map[string]any)["effective_policy_id"])
		}
	}
	owner.ok(http.MethodPut, apiPrefix+"/users/"+viewerID.String()+"/grants", map[string]any{"group_ids": []string{child}, "device_ids": []string{}})
	visible := items(t, viewer.ok(http.MethodGet, apiPrefix+"/groups", nil))
	require.Len(t, visible, 1)
	require.Equal(t, child, visible[0]["id"])
	require.Nil(t, visible[0]["policy_id"])
	require.Equal(t, policyID, visible[0]["effective_policy_id"])
}
