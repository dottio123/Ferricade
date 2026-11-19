package adminapi

import (
	"context"
	"encoding/base64"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/store/db"
)

// t50: fixes from the security review of the User role (t45).

func TestUserEventsResyncAfterGroupMove(t *testing.T) {
	old := userEventsDebounce
	userEventsDebounce = 20 * time.Millisecond
	t.Cleanup(func() { userEventsDebounce = old })
	e, owner, viewer, _, _, group, visible, _ := userEventsFixture(t, true)
	sub := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Sub", "parent_id": group})["id"].(string)
	owner.ok(http.MethodPatch, apiPrefix+"/devices/"+visible, map[string]any{"group_id": sub})
	s := openStream(t, eventsServer(t, e, nil), viewer)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	owner.ok(http.MethodPost, apiPrefix+"/groups/"+sub+"/move", map[string]any{"parent_id": nil})
	require.Equal(t, `data: {"type":"resync"}`, s.waitFor(t, "event: resync", time.Second))
	require.True(t, s.ended(t, time.Second))
}

func putPrefs(c *client, pins []string) map[string]any {
	return c.ok(http.MethodPut, apiPrefix+"/me/preferences", map[string]any{
		"preset": "custom", "modules": []any{}, "pinned_device_ids": pins, "theme": "system", "density": "comfortable",
	})
}

func TestUserPinsDropHiddenDevices(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	viewer, viewerID := e.signedIn("viewer", "user")
	seen := e.enroll(srv, "920000001")
	hidden := e.enroll(srv, "920000002")
	for _, id := range []uuid.UUID{seen, hidden} {
		owner.ok(http.MethodPost, apiPrefix+"/devices/"+id.String()+"/approve", nil)
	}
	owner.ok(http.MethodPut, apiPrefix+"/users/"+viewerID.String()+"/grants", map[string]any{
		"group_ids": []string{}, "device_ids": []string{seen.String()},
	})
	got := putPrefs(viewer, []string{hidden.String(), uuid.NewString(), seen.String()})
	require.Equal(t, []any{seen.String()}, got["pinned_device_ids"])
	require.Equal(t, []any{seen.String()}, viewer.ok(http.MethodGet, apiPrefix+"/me/preferences", nil)["pinned_device_ids"])
	// Owners still keep every approved device.
	require.Len(t, putPrefs(owner, []string{hidden.String(), seen.String()})["pinned_device_ids"], 2)
}

func TestUserDeviceCursorHiddenLooksUnknown(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	viewer, viewerID := e.signedIn("viewer", "user")
	hidden := e.enroll(srv, "930000001")
	seen := e.enroll(srv, "930000002")
	for _, id := range []uuid.UUID{seen, hidden} {
		owner.ok(http.MethodPost, apiPrefix+"/devices/"+id.String()+"/approve", nil)
	}
	owner.ok(http.MethodPut, apiPrefix+"/users/"+viewerID.String()+"/grants", map[string]any{
		"group_ids": []string{}, "device_ids": []string{seen.String()},
	})
	cursor := func(id uuid.UUID) string { return base64.RawURLEncoding.EncodeToString(id[:]) }
	asHidden := viewer.do(http.MethodGet, apiPrefix+"/devices?cursor="+cursor(hidden), nil)
	asUnknown := viewer.do(http.MethodGet, apiPrefix+"/devices?cursor="+cursor(uuid.New()), nil)
	require.Equal(t, asUnknown.Code, asHidden.Code)
	require.JSONEq(t, asUnknown.Body.String(), asHidden.Body.String())
}

func TestEventsResyncWhenRoleChangedWithoutNotification(t *testing.T) {
	e, _, _, _, _, _, _, _ := userEventsFixture(t, false)
	admin, adminID := e.signedIn("admin", "admin")
	s := openStream(t, eventsServer(t, e, nil), admin)
	require.Equal(t, "retry: 3000", s.next(t, time.Second))
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE users SET role = 'user' WHERE id = $1`, adminID)
	require.NoError(t, err)
	require.Equal(t, `data: {"type":"resync"}`, s.waitFor(t, "event: resync", 2*time.Second))
	require.True(t, s.ended(t, time.Second))
}

func TestUserAuditOnlyAuthAndConnectLinks(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	viewer, viewerID := e.signedIn("viewer", "user")
	ctx := context.Background()
	for _, action := range []string{"device.approved", "user.created", "device.connect_link"} {
		require.NoError(t, audit.Record(ctx, db.New(e.d.Pool), audit.Event{
			ActorUserID: &viewerID, ActorIP: deviceIP, Action: action, TargetType: "device", TargetID: uuid.NewString(),
		}))
	}
	seen := map[string]bool{}
	for _, entry := range items(t, viewer.ok(http.MethodGet, apiPrefix+"/audit?limit=200", nil)) {
		seen[entry["action"].(string)] = true
	}
	require.True(t, seen["auth.login"])
	require.True(t, seen["device.connect_link"])
	require.False(t, seen["device.approved"])
	require.False(t, seen["user.created"])
	// An action filter cannot reach past the rule.
	require.Empty(t, items(t, viewer.ok(http.MethodGet, apiPrefix+"/audit?action=device.approved", nil)))
}

func TestUserDirectDeviceHidesUngrantedGroupID(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	viewer, viewerID := e.signedIn("viewer", "user")
	group := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Ungranted"})["id"].(string)
	id := e.enroll(srv, "940000001")
	owner.ok(http.MethodPost, apiPrefix+"/devices/"+id.String()+"/approve", nil)
	owner.ok(http.MethodPatch, apiPrefix+"/devices/"+id.String(), map[string]any{"group_id": group})
	owner.ok(http.MethodPut, apiPrefix+"/users/"+viewerID.String()+"/grants", map[string]any{
		"group_ids": []string{}, "device_ids": []string{id.String()},
	})
	list := items(t, viewer.ok(http.MethodGet, apiPrefix+"/devices", nil))
	require.Len(t, list, 1)
	require.Nil(t, list[0]["group_id"])
	require.Nil(t, viewer.ok(http.MethodGet, apiPrefix+"/devices/"+id.String(), nil)["group_id"])
	require.Equal(t, group, owner.ok(http.MethodGet, apiPrefix+"/devices/"+id.String(), nil)["group_id"])
}

func TestUserDoesNotSeeAddresses(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	viewer, viewerID := e.signedIn("viewer", "user")
	id := e.enroll(srv, "950000001")
	owner.ok(http.MethodPost, apiPrefix+"/devices/"+id.String()+"/approve", nil)
	owner.ok(http.MethodPut, apiPrefix+"/users/"+viewerID.String()+"/grants", map[string]any{
		"group_ids": []string{}, "device_ids": []string{id.String()},
	})
	_, err := e.d.Devices.Heartbeat(context.Background(), srv.ID, wire.HeartbeatRequest{ID: "950000001", UUID: "bmV3"}, deviceIP)
	require.NoError(t, err)
	e.session(srv, "950000001", 1, intp(0), e.clock.Now().Add(-time.Hour), time.Minute)

	alertIP := func(c *client) any {
		return c.ok(http.MethodGet, apiPrefix+"/devices/"+id.String(), nil)["open_alerts"].([]any)[0].(map[string]any)["ip"]
	}
	require.NotEmpty(t, alertIP(owner))
	require.Equal(t, "", alertIP(viewer))
	sessions := items(t, owner.ok(http.MethodGet, apiPrefix+"/sessions", nil))
	require.Len(t, sessions, 1)
	require.NotNil(t, sessions[0]["client_ip"])
	sessions = items(t, viewer.ok(http.MethodGet, apiPrefix+"/sessions", nil))
	require.Len(t, sessions, 1)
	require.Nil(t, sessions[0]["client_ip"])
	require.Equal(t, "laptop", sessions[0]["peer_name"])
	list := items(t, viewer.ok(http.MethodGet, apiPrefix+"/devices", nil))
	require.Equal(t, "", list[0]["open_alerts"].([]any)[0].(map[string]any)["ip"])
}
