package adminapi

import (
	"context"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/servers"
	"github.com/dottio123/ferricade/internal/store/db"
)

const testUUID = "dXVpZC1h"

var deviceIP = netip.MustParseAddr("198.51.100.20")

// signedIn creates an active user without TOTP and returns a client signed in
// as it, which can reach every endpoint its role allows.
func (e *env) signedIn(username, role string) (*client, uuid.UUID) {
	e.t.Helper()
	id := e.createUser(username, userOpts{role: role})
	c := e.client()
	require.Equal(e.t, http.StatusOK, c.login(username, goodPassword).Code)
	return c, id
}

// enroll enrolls a pending device through the client path and returns its ID.
func (e *env) enroll(srv db.Server, rustdeskID string) uuid.UUID {
	e.t.Helper()
	ctx := context.Background()
	_, err := e.d.Devices.Heartbeat(ctx, srv.ID, wire.HeartbeatRequest{ID: rustdeskID, UUID: testUUID}, deviceIP)
	require.NoError(e.t, err)
	d, err := db.New(e.d.Pool).GetClientDevice(ctx, db.GetClientDeviceParams{ServerID: srv.ID, RustdeskID: rustdeskID})
	require.NoError(e.t, err)
	return d.ID
}

func (c *client) ok(method, path string, body any) map[string]any {
	c.e.t.Helper()
	rec := c.do(method, path, body)
	require.True(c.e.t, rec.Code == http.StatusOK || rec.Code == http.StatusCreated, "%s %s: %d %s", method, path, rec.Code, rec.Body.String())
	return decodeBody(c.e.t, rec)
}

func items(t *testing.T, body map[string]any) []map[string]any {
	t.Helper()
	raw, ok := body["items"].([]any)
	require.True(t, ok, "items: %v", body)
	out := make([]map[string]any, len(raw))
	for i, v := range raw {
		out[i] = v.(map[string]any)
	}
	return out
}

func TestDeviceEndpoints(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	idA := e.enroll(srv, "100000001")
	idB := e.enroll(srv, "100000002")
	e.clock.Add(time.Minute) // the enrolling heartbeats are no longer recent
	e.d.Tracker.Beat("100000002", []int32{7})

	body := c.ok(http.MethodGet, apiPrefix+"/devices", nil)
	list := items(t, body)
	require.Len(t, list, 2)
	require.Equal(t, "", body["next_cursor"])
	require.Equal(t, "100000001", list[0]["rustdesk_id"])
	require.Equal(t, false, list[0]["online"])
	require.Equal(t, []any{}, list[0]["conns"])
	require.Equal(t, true, list[1]["online"])
	require.Equal(t, []any{float64(7)}, list[1]["conns"])
	require.Equal(t, "pending", list[1]["state"])

	list = items(t, c.ok(http.MethodGet, apiPrefix+"/devices?online=true", nil))
	require.Len(t, list, 1)
	require.Equal(t, idB.String(), list[0]["id"])

	body = c.ok(http.MethodGet, apiPrefix+"/devices?limit=1", nil)
	require.Len(t, items(t, body), 1)
	next := body["next_cursor"].(string)
	require.NotEmpty(t, next)
	list = items(t, c.ok(http.MethodGet, apiPrefix+"/devices?limit=1&cursor="+url.QueryEscape(next), nil))
	require.Equal(t, "100000002", list[0]["rustdesk_id"])

	for _, q := range []string{"state=bogus", "online=maybe", "tag=x", "group=x", "subgroups=true", "limit=0", "limit=x", "cursor=%25%25"} {
		requireError(t, c.do(http.MethodGet, apiPrefix+"/devices?"+q, nil), http.StatusBadRequest, "bad_request")
	}

	// Transitions.
	d := c.ok(http.MethodPost, apiPrefix+"/devices/"+idA.String()+"/approve", nil)
	require.Equal(t, "approved", d["state"])
	require.NotNil(t, d["approved_by"])
	requireError(t, c.do(http.MethodPost, apiPrefix+"/devices/"+idA.String()+"/approve", nil), http.StatusConflict, "bad_transition")
	requireError(t, c.do(http.MethodPost, apiPrefix+"/devices/"+idA.String()+"/restore", nil), http.StatusConflict, "bad_transition")
	requireError(t, c.do(http.MethodPost, apiPrefix+"/devices/"+idB.String()+"/restore", nil), http.StatusConflict, "bad_transition")
	require.Equal(t, "archived", c.ok(http.MethodPost, apiPrefix+"/devices/"+idA.String()+"/archive", nil)["state"])
	requireError(t, c.do(http.MethodPost, apiPrefix+"/devices/"+idA.String()+"/approve", nil), http.StatusConflict, "bad_transition")
	require.Equal(t, "approved", c.ok(http.MethodPost, apiPrefix+"/devices/"+idA.String()+"/restore", nil)["state"])
	require.Equal(t, "rejected", c.ok(http.MethodPost, apiPrefix+"/devices/"+idB.String()+"/reject", nil)["state"])
	// Reopen undoes a reject: the device waits for approval again.
	require.Equal(t, "pending", c.ok(http.MethodPost, apiPrefix+"/devices/"+idB.String()+"/reopen", nil)["state"])
	requireError(t, c.do(http.MethodPost, apiPrefix+"/devices/"+idB.String()+"/reopen", nil), http.StatusConflict, "bad_transition")
	d = c.ok(http.MethodPost, apiPrefix+"/devices/"+idA.String()+"/reopen", nil)
	require.Equal(t, "pending", d["state"])
	require.Nil(t, d["approved_by"])
	require.Nil(t, d["approved_at"])
	require.Equal(t, "approved", e.auditEntries("device.reopened")[0].Details["from"])
	requireError(t, c.do(http.MethodPost, apiPrefix+"/devices/"+idA.String()+"/reopen", nil), http.StatusConflict, "bad_transition")
	require.Equal(t, "approved", c.ok(http.MethodPost, apiPrefix+"/devices/"+idA.String()+"/approve", nil)["state"])
	require.Equal(t, "archived", c.ok(http.MethodPost, apiPrefix+"/devices/"+idA.String()+"/archive", nil)["state"])
	requireError(t, c.do(http.MethodPost, apiPrefix+"/devices/"+idA.String()+"/reopen", nil), http.StatusConflict, "bad_transition")
	require.Equal(t, "approved", c.ok(http.MethodPost, apiPrefix+"/devices/"+idA.String()+"/restore", nil)["state"])
	require.Equal(t, "rejected", c.ok(http.MethodPost, apiPrefix+"/devices/"+idB.String()+"/reject", nil)["state"])
	require.Len(t, e.auditEntries("device.approved"), 2)
	require.Len(t, e.auditEntries("device.archived"), 2)
	require.Len(t, e.auditEntries("device.restored"), 2)
	require.Len(t, e.auditEntries("device.rejected"), 2)
	require.Len(t, e.auditEntries("device.reopened"), 2)
	requireError(t, c.do(http.MethodPost, apiPrefix+"/devices/"+uuid.NewString()+"/approve", nil), http.StatusNotFound, "not_found")
	requireError(t, c.do(http.MethodGet, apiPrefix+"/devices/not-a-uuid", nil), http.StatusNotFound, "not_found")

	// PATCH and GET.
	tag := c.ok(http.MethodPost, apiPrefix+"/tags", map[string]any{"name": "lab", "color": 4280391411})
	grp := c.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Office"})
	d = c.ok(http.MethodPatch, apiPrefix+"/devices/"+idA.String(), map[string]any{
		"alias": "Reception", "note": "desk 1", "group_id": grp["id"], "tag_ids": []any{tag["id"]},
	})
	require.Equal(t, "Reception", d["alias"])
	require.Equal(t, grp["id"], d["group_id"])
	require.Equal(t, []any{map[string]any{"id": tag["id"], "name": "lab", "color": float64(4280391411)}}, d["tags"])
	d = c.ok(http.MethodPatch, apiPrefix+"/devices/"+idA.String(), map[string]any{"group_id": nil})
	require.Nil(t, d["group_id"])
	require.Equal(t, "Reception", d["alias"], "absent fields are kept")
	d = c.ok(http.MethodPatch, apiPrefix+"/devices/"+idA.String(), map[string]any{"alias": "", "note": ""})
	require.Equal(t, "", d["alias"])
	require.Equal(t, "", d["note"])
	requireError(t, c.do(http.MethodPatch, apiPrefix+"/devices/"+idA.String(), map[string]any{"tag_ids": []string{uuid.NewString()}}),
		http.StatusBadRequest, "bad_request")
	requireError(t, c.do(http.MethodPatch, apiPrefix+"/devices/"+idA.String(), map[string]any{"bogus": 1}),
		http.StatusBadRequest, "bad_request")
	require.Len(t, e.auditEntries("device.updated"), 3)

	list = items(t, c.ok(http.MethodGet, apiPrefix+"/devices?tag="+tag["id"].(string), nil))
	require.Len(t, list, 1)
	require.Equal(t, idA.String(), list[0]["id"])

	// A uuid mismatch shows as an open alert, which can be resolved.
	_, err := e.d.Devices.Heartbeat(context.Background(), srv.ID, wire.HeartbeatRequest{ID: "100000001", UUID: "bmV3"}, deviceIP)
	require.NoError(t, err)
	d = c.ok(http.MethodGet, apiPrefix+"/devices/"+idA.String(), nil)
	alerts := d["open_alerts"].([]any)
	require.Len(t, alerts, 1)
	alert := alerts[0].(map[string]any)
	require.Equal(t, "uuid_mismatch", alert["kind"])
	require.Equal(t, "bmV3", alert["seen_uuid"])
	resolve := apiPrefix + "/devices/" + idA.String() + "/alerts/" + alert["id"].(string) + "/resolve"
	requireError(t, c.do(http.MethodPost, resolve, map[string]any{"action": "ignore"}), http.StatusBadRequest, "bad_request")
	d = c.ok(http.MethodPost, resolve, map[string]any{"action": "accept_new_uuid"})
	require.Equal(t, "bmV3", d["uuid"])
	require.Equal(t, []any{}, d["open_alerts"])
	requireError(t, c.do(http.MethodPost, resolve, map[string]any{"action": "dismiss"}), http.StatusNotFound, "not_found")
	require.Len(t, e.auditEntries("device.alert_resolved"), 1)
}

func TestDeviceUngroupedFilter(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("ungrouped-owner", "owner")
	ids := []uuid.UUID{
		e.enroll(srv, "ungrouped-a"),
		e.enroll(srv, "ungrouped-b"),
		e.enroll(srv, "ungrouped-c"),
	}
	group := c.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Grouped"})["id"].(string)
	c.ok(http.MethodPatch, apiPrefix+"/devices/"+ids[1].String(), map[string]any{"group_id": group})
	approved := c.ok(http.MethodPost, apiPrefix+"/devices/"+ids[0].String()+"/approve", nil)
	require.Equal(t, "approved", approved["state"])
	c.ok(http.MethodPost, apiPrefix+"/devices/"+ids[1].String()+"/approve", nil)
	c.ok(http.MethodPost, apiPrefix+"/devices/"+ids[2].String()+"/approve", nil)

	var ownerIDs []string
	cursor := ""
	for {
		path := apiPrefix + "/devices?state=approved&ungrouped=true&limit=1"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		page := c.ok(http.MethodGet, path, nil)
		for _, item := range items(t, page) {
			ownerIDs = append(ownerIDs, item["id"].(string))
			require.Nil(t, item["group_id"])
		}
		cursor = page["next_cursor"].(string)
		if cursor == "" {
			break
		}
	}
	require.ElementsMatch(t, []string{ids[0].String(), ids[2].String()}, ownerIDs)
	requireError(t, c.do(http.MethodGet, apiPrefix+"/devices?group="+group+"&ungrouped=true", nil), http.StatusBadRequest, codeBadRequest)
	requireError(t, c.do(http.MethodGet, apiPrefix+"/devices?group="+group+"&subgroups=true&ungrouped=true", nil), http.StatusBadRequest, codeBadRequest)
	for _, value := range []string{"maybe"} {
		requireError(t, c.do(http.MethodGet, apiPrefix+"/devices?ungrouped="+value, nil), http.StatusBadRequest, codeBadRequest)
	}
	list := items(t, c.ok(http.MethodGet, apiPrefix+"/devices?ungrouped=false", nil))
	require.Len(t, list, 3)

	user, userID := e.signedIn("ungrouped-viewer", "user")
	c.ok(http.MethodPut, apiPrefix+"/users/"+userID.String()+"/grants", map[string]any{
		"group_ids": []string{group}, "device_ids": []string{ids[2].String()},
	})
	userList := items(t, user.ok(http.MethodGet, apiPrefix+"/devices?ungrouped=true", nil))
	require.Len(t, userList, 1)
	require.Equal(t, ids[2].String(), userList[0]["id"])
	require.Nil(t, userList[0]["group_id"])
}

func TestConnectEndpoint(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, aliceID := e.signedIn("alice", "admin")
	owner, _ := e.signedIn("server-owner", "owner")
	id := e.enroll(srv, "123456789")
	connect := apiPrefix + "/devices/" + id.String() + "/connect"

	requireError(t, c.do(http.MethodGet, connect, nil), http.StatusNotFound, "not_found")
	c.ok(http.MethodPost, apiPrefix+"/devices/"+id.String()+"/approve", nil)

	// Links name the ID server and key, so they work from a client set to
	// another ID server; only '+' is escaped in the URL, raw in the command.
	const q = "?key=OeVuKk5nlHiXp%2BAPNn0Y3pC1Iwpwn44JGqrQCsWqmBw="
	require.Equal(t, map[string]any{
		"url":             "rustdesk://123456789@rd.example.com" + q,
		"command":         `rustdesk --connect "123456789@rd.example.com?key=` + validKey + `"`,
		"id":              "123456789",
		"includes_server": true,
	}, c.ok(http.MethodGet, connect, nil))
	require.Equal(t, map[string]any{
		"url":             "rustdesk://file-transfer/123456789/r@rd.example.com" + q,
		"command":         `rustdesk --file-transfer "123456789/r@rd.example.com?key=` + validKey + `"`,
		"id":              "123456789",
		"includes_server": true,
	}, c.ok(http.MethodGet, connect+"?action=file-transfer&relay=1", nil))
	for _, action := range []string{"connect", "file-transfer", "port-forward", "terminal"} {
		for _, relay := range []string{"0", "1"} {
			got := c.ok(http.MethodGet, connect+"?action="+action+"&relay="+relay, nil)
			target := "123456789"
			if relay == "1" {
				target += "/r"
			}
			path := target + "@rd.example.com"
			if action != "connect" {
				path = action + "/" + path
			}
			require.Equal(t, true, got["includes_server"])
			require.Equal(t, "rustdesk://"+path+q, got["url"])
			require.Equal(t, `rustdesk --`+action+` "`+target+`@rd.example.com?key=`+validKey+`"`, got["command"])
		}
	}
	owner.ok(http.MethodPatch, apiPrefix+"/server", map[string]any{"links_include_server": false})
	for _, action := range []string{"connect", "file-transfer", "port-forward", "terminal"} {
		for _, relay := range []string{"0", "1"} {
			got := c.ok(http.MethodGet, connect+"?action="+action+"&relay="+relay, nil)
			require.Equal(t, false, got["includes_server"])
			target := "123456789"
			if relay == "1" {
				target += "/r"
			}
			path := target
			if action != "connect" {
				path = action + "/" + target
			}
			require.Equal(t, "rustdesk://"+path, got["url"])
			require.Equal(t, `rustdesk --`+action+` `+target, got["command"])
		}
	}
	requireError(t, c.do(http.MethodGet, connect+"?action=shell", nil), http.StatusBadRequest, "bad_request")
	requireError(t, c.do(http.MethodGet, connect+"?relay=2", nil), http.StatusBadRequest, "bad_request")
	requireError(t, c.do(http.MethodGet, apiPrefix+"/devices/"+uuid.NewString()+"/connect", nil), http.StatusNotFound, "not_found")

	got := e.auditEntries("device.connect_link")
	require.Len(t, got, 18)
	require.Equal(t, &aliceID, got[0].ActorUserID)
	require.Equal(t, id.String(), got[0].TargetID)
	require.Equal(t, map[string]any{"rustdesk_id": "123456789", "action": "terminal", "relay": true}, got[0].Details)

	c.ok(http.MethodPost, apiPrefix+"/devices/"+id.String()+"/archive", nil)
	requireError(t, c.do(http.MethodGet, connect, nil), http.StatusNotFound, "not_found")
}

func TestDeleteDeviceEndpoint(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, aliceID := e.signedIn("alice", "admin")
	id := e.enroll(srv, "123456789")
	other := e.enroll(srv, "123456780")
	path := apiPrefix + "/devices/" + id.String()

	rec := c.do(http.MethodDelete, path, nil)
	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Empty(t, rec.Body.String())
	requireError(t, c.do(http.MethodGet, path, nil), http.StatusNotFound, "not_found")
	requireError(t, c.do(http.MethodDelete, path, nil), http.StatusNotFound, "not_found")
	requireError(t, c.do(http.MethodDelete, apiPrefix+"/devices/not-a-uuid", nil), http.StatusNotFound, "not_found")

	list := items(t, c.ok(http.MethodGet, apiPrefix+"/devices", nil))
	require.Len(t, list, 1)
	require.Equal(t, other.String(), list[0]["id"])

	got := e.auditEntries("device.deleted")
	require.Len(t, got, 1)
	require.Equal(t, &aliceID, got[0].ActorUserID)
	require.Equal(t, id.String(), got[0].TargetID)
	require.Equal(t, "123456789", got[0].Details["rustdesk_id"])
	require.Equal(t, "pending", got[0].Details["state"])
}

func TestMoveGroupUnderDescendantRefused(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "admin")
	a := c.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "a"})
	b := c.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "b", "parent_id": a["id"]})
	cc := c.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "c", "parent_id": b["id"]})
	requireError(t, c.do(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "b", "parent_id": a["id"]}),
		http.StatusConflict, "name_taken")

	move := func(id any) string { return apiPrefix + "/groups/" + id.(string) + "/move" }
	requireError(t, c.do(http.MethodPost, move(a["id"]), map[string]any{"parent_id": cc["id"]}), http.StatusConflict, "cycle")
	requireError(t, c.do(http.MethodPost, move(a["id"]), map[string]any{"parent_id": a["id"]}), http.StatusConflict, "cycle")
	requireError(t, c.do(http.MethodPost, move(a["id"]), map[string]any{}), http.StatusBadRequest, "bad_request")
	requireError(t, c.do(http.MethodPost, move(a["id"]), map[string]any{"parent_id": uuid.NewString()}), http.StatusBadRequest, "bad_request")

	moved := c.ok(http.MethodPost, move(cc["id"]), map[string]any{"parent_id": nil})
	require.Nil(t, moved["parent_id"])
	renamed := c.ok(http.MethodPatch, apiPrefix+"/groups/"+cc["id"].(string), map[string]any{"name": "z"})
	require.Equal(t, "z", renamed["name"])

	tree := items(t, c.ok(http.MethodGet, apiPrefix+"/groups", nil))
	require.Len(t, tree, 2)
	require.Equal(t, "a", tree[0]["name"])
	require.Equal(t, "b", tree[0]["children"].([]any)[0].(map[string]any)["name"])
	require.Equal(t, "z", tree[1]["name"])
	require.Equal(t, []any{}, tree[1]["children"])
	require.Len(t, e.auditEntries("group.created"), 3)
	require.Len(t, e.auditEntries("group.moved"), 1)
	require.Len(t, e.auditEntries("group.renamed"), 1)
}

func TestDeleteGroupNotEmpty(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("alice", "admin")
	dev := e.enroll(srv, "100000001")
	g := c.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "g"})
	child := c.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "child", "parent_id": g["id"]})
	gPath := apiPrefix + "/groups/" + g["id"].(string)

	requireError(t, c.do(http.MethodDelete, gPath, nil), http.StatusConflict, "not_empty")
	require.Equal(t, http.StatusNoContent, c.do(http.MethodDelete, apiPrefix+"/groups/"+child["id"].(string), nil).Code)

	c.ok(http.MethodPatch, apiPrefix+"/devices/"+dev.String(), map[string]any{"group_id": g["id"]})
	requireError(t, c.do(http.MethodDelete, gPath, nil), http.StatusConflict, "not_empty")
	c.ok(http.MethodPatch, apiPrefix+"/devices/"+dev.String(), map[string]any{"group_id": nil})

	require.Equal(t, http.StatusNoContent, c.do(http.MethodDelete, gPath, nil).Code)
	requireError(t, c.do(http.MethodDelete, gPath, nil), http.StatusNotFound, "not_found")
	require.Len(t, e.auditEntries("group.deleted"), 2)
}

func TestTagEndpoints(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "admin")

	tag := c.ok(http.MethodPost, apiPrefix+"/tags", map[string]any{"name": "Servers", "color": 4280391411})
	require.Equal(t, float64(4280391411), tag["color"])
	requireError(t, c.do(http.MethodPost, apiPrefix+"/tags", map[string]any{"name": "servers", "color": 1}), http.StatusConflict, "name_taken")
	requireError(t, c.do(http.MethodPost, apiPrefix+"/tags", map[string]any{"name": "x", "color": 1 << 32}), http.StatusBadRequest, "bad_request")
	requireError(t, c.do(http.MethodPost, apiPrefix+"/tags", map[string]any{"name": " ", "color": 1}), http.StatusBadRequest, "bad_request")
	c.ok(http.MethodPost, apiPrefix+"/tags", map[string]any{"name": "alpha", "color": 0})

	body := c.ok(http.MethodGet, apiPrefix+"/tags?limit=1", nil)
	require.Equal(t, "alpha", items(t, body)[0]["name"])
	body = c.ok(http.MethodGet, apiPrefix+"/tags?limit=1&cursor="+url.QueryEscape(body["next_cursor"].(string)), nil)
	require.Equal(t, "Servers", items(t, body)[0]["name"])
	require.Equal(t, "", body["next_cursor"])
	requireError(t, c.do(http.MethodGet, apiPrefix+"/tags?cursor=!", nil), http.StatusBadRequest, "bad_request")

	path := apiPrefix + "/tags/" + tag["id"].(string)
	updated := c.ok(http.MethodPatch, path, map[string]any{"color": 255})
	require.Equal(t, "Servers", updated["name"])
	require.Equal(t, float64(255), updated["color"])
	require.Equal(t, http.StatusNoContent, c.do(http.MethodDelete, path, nil).Code)
	requireError(t, c.do(http.MethodDelete, path, nil), http.StatusNotFound, "not_found")
	requireError(t, c.do(http.MethodPatch, path, map[string]any{"color": 1}), http.StatusNotFound, "not_found")
	require.Len(t, e.auditEntries("tag.created"), 2)
	require.Len(t, e.auditEntries("tag.updated"), 1)
	require.Len(t, e.auditEntries("tag.deleted"), 1)
}

func TestCreateUser(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, ownerID := e.signedIn("alice", "owner")

	rec := c.do(http.MethodPost, apiPrefix+"/users", map[string]any{
		"username": "bob", "password": goodPassword, "display_name": "Bob", "email": "bob@example.com", "role": "admin",
	})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.NotContains(t, rec.Body.String(), "password")
	require.NotContains(t, rec.Body.String(), "totp_secret")
	u := decodeBody(t, rec)
	require.Equal(t, "bob", u["username"])
	require.Equal(t, "admin", u["role"])
	require.Equal(t, "active", u["status"])
	require.Equal(t, false, u["totp_required"])

	requireError(t, c.do(http.MethodPost, apiPrefix+"/users", map[string]any{
		"username": "BOB", "password": goodPassword, "role": "admin",
	}), http.StatusConflict, "username_taken")
	requireError(t, c.do(http.MethodPost, apiPrefix+"/users", map[string]any{
		"username": "carol", "password": "short", "role": "admin",
	}), http.StatusBadRequest, "weak_password")
	requireError(t, c.do(http.MethodPost, apiPrefix+"/users", map[string]any{
		"username": "carol", "password": goodPassword, "role": "root",
	}), http.StatusBadRequest, "bad_request")
	requireError(t, c.do(http.MethodPost, apiPrefix+"/users", map[string]any{
		"username": "bad name", "password": goodPassword, "role": "admin",
	}), http.StatusBadRequest, "bad_request")

	// A new owner must use TOTP.
	o := c.ok(http.MethodPost, apiPrefix+"/users", map[string]any{"username": "olga", "password": goodPassword, "role": "owner"})
	require.Equal(t, true, o["totp_required"])

	got := e.auditEntries("user.created")
	require.Len(t, got, 2)
	require.Equal(t, &ownerID, got[1].ActorUserID)
	require.Equal(t, u["id"], got[1].TargetID)

	bob := e.client()
	require.Equal(t, http.StatusOK, bob.login("bob", goodPassword).Code)

	// Promotion to owner turns TOTP on.
	p := c.ok(http.MethodPatch, apiPrefix+"/users/"+u["id"].(string), map[string]any{"role": "owner"})
	require.Equal(t, true, p["totp_required"])

	list := items(t, c.ok(http.MethodGet, apiPrefix+"/users", nil))
	require.Len(t, list, 3)
	require.Equal(t, "alice", list[0]["username"])
	require.NotContains(t, list[0], "password_hash")
}

func TestCannotRemoveLastOwner(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, aliceID := e.signedIn("alice", "owner")
	alice := apiPrefix + "/users/" + aliceID.String()

	requireError(t, c.do(http.MethodPatch, alice, map[string]any{"role": "admin"}), http.StatusConflict, "last_owner")
	requireError(t, c.do(http.MethodPatch, alice, map[string]any{"status": "disabled"}), http.StatusConflict, "last_owner")
	row, err := db.New(e.d.Pool).GetUserByID(context.Background(), aliceID)
	require.NoError(t, err)
	require.Equal(t, "owner", row.Role)
	require.Equal(t, "active", row.Status)
	require.Empty(t, e.auditEntries("user.updated"))

	// Other changes to the last owner are fine, but an owner keeps TOTP.
	require.Equal(t, "Alice", c.ok(http.MethodPatch, alice, map[string]any{"display_name": "Alice"})["display_name"])
	requireError(t, c.do(http.MethodPatch, alice, map[string]any{"totp_required": false}), http.StatusBadRequest, "bad_request")

	// With a second active owner, alice can step down; then carol is the last.
	carolID := e.createUser("carol", userOpts{role: "owner"})
	u := c.ok(http.MethodPatch, alice, map[string]any{"role": "admin"})
	require.Equal(t, "admin", u["role"])
	requireError(t, c.do(http.MethodGet, apiPrefix+"/users", nil), http.StatusForbidden, "forbidden")

	carol := e.client()
	require.Equal(t, http.StatusOK, carol.login("carol", goodPassword).Code)
	requireError(t, carol.do(http.MethodPatch, apiPrefix+"/users/"+carolID.String(), map[string]any{"role": "admin"}),
		http.StatusConflict, "last_owner")

	got := e.auditEntries("user.updated")
	require.Len(t, got, 2)
	require.Equal(t, map[string]any{
		"before": map[string]any{"role": "owner"},
		"after":  map[string]any{"role": "admin"},
	}, got[0].Details)
}

// Two owners demoting each other at once: the owner rows are locked before
// either update, so exactly one change wins and one active owner remains.
func TestLastOwnerConcurrentDemotions(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	for i := range 10 {
		alice, aliceID := e.signedIn(fmt.Sprintf("alice%d", i), "owner")
		carol, carolID := e.signedIn(fmt.Sprintf("carol%d", i), "owner")
		// Earlier rounds' owners are disabled so these two are the only ones.
		var codes [2]int
		var wg sync.WaitGroup
		for j, c := range []struct {
			cl     *client
			target uuid.UUID
		}{{alice, carolID}, {carol, aliceID}} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				codes[j] = c.cl.do(http.MethodPatch, apiPrefix+"/users/"+c.target.String(), map[string]any{"role": "admin"}).Code
			}()
		}
		wg.Wait()
		ok := 0
		for _, code := range codes {
			if code == http.StatusOK {
				ok++
			} else {
				// The loser either saw one owner left, or had already lost its role.
				require.Contains(t, []int{http.StatusConflict, http.StatusForbidden}, code)
			}
		}
		require.Equal(t, 1, ok, "codes %v", codes)
		var owners int
		require.NoError(t, e.d.Pool.QueryRow(context.Background(),
			`SELECT count(*) FROM users WHERE role = 'owner' AND status = 'active'`).Scan(&owners))
		require.Equal(t, 1, owners)
		_, err := e.d.Pool.Exec(context.Background(), `UPDATE users SET status = 'disabled' WHERE role = 'owner'`)
		require.NoError(t, err)
	}
}

func TestAdminCannotManageUsers(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	_, ownerID := e.signedIn("alice", "owner")
	c, bobID := e.signedIn("bob", "admin")

	requireError(t, c.do(http.MethodPost, apiPrefix+"/users", map[string]any{
		"username": "eve", "password": goodPassword, "role": "admin",
	}), http.StatusForbidden, "forbidden")
	requireError(t, c.do(http.MethodGet, apiPrefix+"/users", nil), http.StatusForbidden, "forbidden")
	requireError(t, c.do(http.MethodPatch, apiPrefix+"/users/"+ownerID.String(), map[string]any{"status": "disabled"}),
		http.StatusForbidden, "forbidden")
	requireError(t, c.do(http.MethodPatch, apiPrefix+"/users/"+bobID.String(), map[string]any{"role": "owner"}),
		http.StatusForbidden, "forbidden")
	requireError(t, c.do(http.MethodPost, apiPrefix+"/users/"+ownerID.String()+"/reset-totp", nil),
		http.StatusForbidden, "forbidden")
	requireError(t, c.do(http.MethodPatch, apiPrefix+"/server", map[string]any{"name": "x"}), http.StatusForbidden, "forbidden")
	require.Empty(t, e.auditEntries("user.created"))
	require.Empty(t, e.auditEntries("server.updated"))

	// An admin can read the server and run its checks.
	require.Equal(t, "lab", c.ok(http.MethodGet, apiPrefix+"/server", nil)["name"])
	require.Len(t, c.ok(http.MethodPost, apiPrefix+"/server/check", nil)["checks"], 3)
}

func TestDisableUserEndsSessions(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("alice", "owner")
	bob, bobID := e.signedIn("bob", "admin")
	bob2 := e.client()
	require.Equal(t, http.StatusOK, bob2.login("bob", goodPassword).Code)
	require.Equal(t, http.StatusOK, bob.do(http.MethodGet, apiPrefix+"/devices", nil).Code)

	u := owner.ok(http.MethodPatch, apiPrefix+"/users/"+bobID.String(), map[string]any{"status": "disabled"})
	require.Equal(t, "disabled", u["status"])
	var n int
	require.NoError(t, e.d.Pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE user_id = $1`, bobID).Scan(&n))
	require.Zero(t, n, "sessions deleted in the same change")

	requireError(t, bob.do(http.MethodGet, apiPrefix+"/devices", nil), http.StatusUnauthorized, "unauthenticated")
	requireError(t, bob2.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
	requireError(t, e.client().login("bob", goodPassword), http.StatusUnauthorized, "unauthenticated")

	got := e.auditEntries("user.updated")
	require.Len(t, got, 1)
	require.Equal(t, map[string]any{
		"before": map[string]any{"status": "active"},
		"after":  map[string]any{"status": "disabled"},
	}, got[0].Details)

	// Re-enabled, bob can sign in again.
	owner.ok(http.MethodPatch, apiPrefix+"/users/"+bobID.String(), map[string]any{"status": "active"})
	require.Equal(t, http.StatusOK, e.client().login("bob", goodPassword).Code)
}

func TestResetTOTP(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("alice", "owner")
	secret := newSecret(t)
	bobID := e.createUser("bob", userOpts{totpSecret: secret})
	bob := e.client()
	require.Equal(t, http.StatusOK, bob.login("bob", goodPassword).Code)

	rec := owner.do(http.MethodPost, apiPrefix+"/users/"+bobID.String()+"/reset-totp", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotContains(t, rec.Body.String(), "totp_secret")
	row, err := db.New(e.d.Pool).GetUserByID(context.Background(), bobID)
	require.NoError(t, err)
	require.Nil(t, row.TOTPSecretEnc)
	requireError(t, bob.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
	require.Len(t, e.auditEntries("user.totp_reset"), 1)
	requireError(t, owner.do(http.MethodPost, apiPrefix+"/users/"+uuid.NewString()+"/reset-totp", nil), http.StatusNotFound, "not_found")
}

func TestOwnerResetsPassword(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, ownerID := e.signedIn("alice", "owner")
	admin, _ := e.signedIn("carol", "admin")
	secret := newSecret(t)
	bobID := e.createUser("bob", userOpts{totpSecret: secret})
	bob := e.client()
	require.Equal(t, http.StatusOK, bob.login("bob", goodPassword).Code)
	ctx := context.Background()
	_, err := e.d.Pool.Exec(ctx, `UPDATE users SET failed_logins = 5, locked_until = now() + interval '1 hour' WHERE id = $1`, bobID)
	require.NoError(t, err)
	before, err := db.New(e.d.Pool).GetUserByID(ctx, bobID)
	require.NoError(t, err)
	path := apiPrefix + "/users/" + bobID.String() + "/password"
	const newPassword = "a brand new passphrase"

	rec := owner.do(http.MethodPost, path, map[string]any{"password": newPassword})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "bob", decodeBody(t, rec)["username"])
	require.NotContains(t, rec.Body.String(), newPassword)
	require.NotContains(t, rec.Body.String(), "password_hash")

	row, err := db.New(e.d.Pool).GetUserByID(ctx, bobID)
	require.NoError(t, err)
	require.Equal(t, int32(0), row.FailedLogins)
	require.Nil(t, row.LockedUntil)
	require.Equal(t, before.TOTPSecretEnc, row.TOTPSecretEnc)
	require.NotNil(t, row.TOTPSecretEnc)
	var n int
	require.NoError(t, e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id = $1`, bobID).Scan(&n))
	require.Zero(t, n)
	requireError(t, bob.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
	requireError(t, e.client().login("bob", goodPassword), http.StatusUnauthorized, "unauthenticated")
	// A password sign-in now gets as far as the TOTP step (bob has a secret).
	require.NotEqual(t, http.StatusUnauthorized, e.client().login("bob", newPassword).Code)

	got := e.auditEntries("user.password_reset")
	require.Len(t, got, 1)
	require.Empty(t, got[0].Details)
	require.NotNil(t, got[0].ActorUserID)
	require.Equal(t, ownerID, *got[0].ActorUserID)
	require.Equal(t, bobID.String(), got[0].TargetID)

	requireError(t, owner.do(http.MethodPost, path, map[string]any{"password": "short"}), http.StatusBadRequest, "weak_password")
	requireError(t, owner.do(http.MethodPost, path, map[string]any{"password": "password1234"}), http.StatusBadRequest, "weak_password")
	requireError(t, owner.do(http.MethodPost, path, map[string]any{"password": "BoB"}), http.StatusBadRequest, "weak_password")
	requireError(t, owner.do(http.MethodPost, path, map[string]any{"password": strings.Repeat("x", 1025)}), http.StatusBadRequest, "bad_request")
	requireError(t, owner.do(http.MethodPost, path, map[string]any{}), http.StatusBadRequest, "weak_password")
	requireError(t, owner.do(http.MethodPost, path, map[string]any{"password": newPassword, "extra": 1}), http.StatusBadRequest, "bad_request")
	requireError(t, owner.do(http.MethodPost, apiPrefix+"/users/"+ownerID.String()+"/password", map[string]any{"password": newPassword}),
		http.StatusBadRequest, "bad_request")
	requireError(t, owner.do(http.MethodPost, apiPrefix+"/users/"+uuid.NewString()+"/password", map[string]any{"password": newPassword}),
		http.StatusNotFound, "not_found")
	requireError(t, admin.do(http.MethodPost, path, map[string]any{"password": newPassword}), http.StatusForbidden, "forbidden")
	require.Len(t, e.auditEntries("user.password_reset"), 1, "refused attempts are not audited")
}

func TestServerEndpoints(t *testing.T) {
	monitor := &servers.Monitor{Log: quietLog()}
	e := newEnv(t, func(d *Deps) { d.ServerMonitor = monitor })
	c, _ := e.signedIn("alice", "owner")
	healthPath := apiPrefix + "/server/health"
	require.Equal(t, "unknown", c.ok(http.MethodGet, healthPath, nil)["status"])
	requireError(t, e.client().do(http.MethodGet, healthPath, nil), http.StatusUnauthorized, "unauthenticated")
	requireError(t, c.do(http.MethodGet, apiPrefix+"/server", nil), http.StatusNotFound, "not_found")
	srv := e.markSetupComplete()
	admin, _ := e.signedIn("bob", "admin")
	viewer, _ := e.signedIn("viewer", "user")

	s := c.ok(http.MethodGet, apiPrefix+"/server", nil)
	require.Equal(t, srv.ID.String(), s["id"])
	require.Equal(t, "rd.example.com", s["id_host"])
	require.Equal(t, true, s["links_include_server"])

	requireError(t, c.do(http.MethodPatch, apiPrefix+"/server", map[string]any{"id_host": "bad host"}), http.StatusBadRequest, "bad_request")
	requireError(t, c.do(http.MethodPatch, apiPrefix+"/server", map[string]any{"public_key": "abc"}), http.StatusBadRequest, "invalid_key")
	s = c.ok(http.MethodPatch, apiPrefix+"/server", map[string]any{"id_host": " rd2.example.com:21116 "})
	require.Equal(t, "rd2.example.com:21116", s["id_host"])
	require.Equal(t, "relay.example.com", s["relay_host"], "absent fields are kept")
	require.Equal(t, "lab", s["name"])

	got := e.auditEntries("server.updated")
	require.Len(t, got, 1)
	require.Equal(t, map[string]any{
		"before": map[string]any{"id_host": "rd.example.com"},
		"after":  map[string]any{"id_host": "rd2.example.com:21116"},
	}, got[0].Details)

	dials := e.dials.Load()
	checks := c.ok(http.MethodPost, apiPrefix+"/server/check", nil)["checks"].([]any)
	require.Len(t, checks, 3)
	require.Equal(t, map[string]any{"name": "id-server", "ok": true, "detail": "", "target": "rd2.example.com:21116", "address": "pipe", "reason": nil}, checks[0])
	require.Equal(t, map[string]any{"name": "client-api", "ok": true, "detail": "", "target": "rd2.example.com:21114", "address": "pipe", "reason": nil}, checks[2])
	require.Equal(t, dials+3, e.dials.Load(), "checks use Deps.Dial")
	health := c.ok(http.MethodGet, healthPath, nil)
	require.Equal(t, "ok", health["status"])
	require.NotNil(t, health["checked_at"])
	require.Len(t, health["checks"], 3)
	require.Equal(t, health["checks"], admin.ok(http.MethodGet, healthPath, nil)["checks"])
	viewerChecks := viewer.ok(http.MethodGet, healthPath, nil)["checks"].([]any)
	for i, check := range viewerChecks {
		got := check.(map[string]any)
		want := health["checks"].([]any)[i].(map[string]any)
		require.Equal(t, want["name"], got["name"])
		require.Equal(t, want["ok"], got["ok"])
		require.Equal(t, want["reason"], got["reason"])
		require.Equal(t, "", got["detail"])
		require.Equal(t, "", got["target"])
		require.Equal(t, "", got["address"])
	}
	for _, value := range []string{"http://api.example.com", "https://api.example.com/path", "https://api.example.com?x=1", "https://api.example.com#", "https://user@api.example.com", "https://api.example.com:21114", "garbage"} {
		requireError(t, c.do(http.MethodPatch, apiPrefix+"/server", map[string]any{"api_url": value}), http.StatusBadRequest, "bad_request")
	}
	requireError(t, c.do(http.MethodPatch, apiPrefix+"/server", map[string]any{"api_url": nil}), http.StatusBadRequest, "bad_request")
	s = c.ok(http.MethodPatch, apiPrefix+"/server", map[string]any{"api_url": "https://api.example.com:8443/"})
	require.Equal(t, "https://api.example.com:8443", s["api_url"])
	require.Equal(t, "https://api.example.com:8443", c.ok(http.MethodGet, apiPrefix+"/server/client-config", nil)["api"])
	checks = c.ok(http.MethodPost, apiPrefix+"/server/check", nil)["checks"].([]any)
	require.Equal(t, "api.example.com:8443", checks[2].(map[string]any)["target"])
	got = e.auditEntries("server.updated")
	require.Equal(t, map[string]any{"before": map[string]any{"api_url": ""}, "after": map[string]any{"api_url": "https://api.example.com:8443"}}, got[0].Details)
	s = c.ok(http.MethodPatch, apiPrefix+"/server", map[string]any{"links_include_server": false})
	require.Equal(t, false, s["links_include_server"])
	got = e.auditEntries("server.updated")
	require.Equal(t, map[string]any{"before": map[string]any{"links_include_server": true}, "after": map[string]any{"links_include_server": false}}, got[0].Details)
	s = c.ok(http.MethodPatch, apiPrefix+"/server", map[string]any{"api_url": ""})
	require.Equal(t, "", s["api_url"])
	checks = c.ok(http.MethodPost, apiPrefix+"/server/check", nil)["checks"].([]any)
	require.Equal(t, "rd2.example.com:21114", checks[2].(map[string]any)["target"])
	monitor.Record([]servers.Check{{Name: "id-server", Detail: "secret failure", Target: "secret.example:21116", Address: "203.0.113.10:21116", Reason: "refused"}}, e.clock.Now())
	require.Equal(t, "secret failure", c.ok(http.MethodGet, healthPath, nil)["checks"].([]any)[0].(map[string]any)["detail"])
	userCheck := viewer.ok(http.MethodGet, healthPath, nil)["checks"].([]any)[0].(map[string]any)
	require.Equal(t, "", userCheck["detail"])
	require.Equal(t, "", userCheck["target"])
	require.Equal(t, "", userCheck["address"])
	require.Equal(t, "refused", userCheck["reason"])
}

func TestAuditEndpointFilters(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, aliceID := e.signedIn("alice", "admin")
	for i := range 3 {
		c.ok(http.MethodPost, apiPrefix+"/tags", map[string]any{"name": fmt.Sprintf("t%d", i), "color": i})
	}

	body := c.ok(http.MethodGet, apiPrefix+"/audit?action=tag.created&limit=2", nil)
	page := items(t, body)
	require.Len(t, page, 2)
	require.Equal(t, "tag.created", page[0]["action"])
	require.Equal(t, aliceID.String(), page[0]["actor_user_id"])
	require.Equal(t, "t2", page[0]["details"].(map[string]any)["name"], "newest first")
	next := body["next_cursor"].(string)
	require.NotEmpty(t, next)
	body = c.ok(http.MethodGet, apiPrefix+"/audit?action=tag.created&limit=2&cursor="+url.QueryEscape(next), nil)
	require.Len(t, items(t, body), 1)
	require.Equal(t, "", body["next_cursor"])

	all := items(t, c.ok(http.MethodGet, apiPrefix+"/audit?actor="+aliceID.String(), nil))
	require.Len(t, all, 4, "auth.login and three tag.created")
	target := page[0]["target_id"].(string)
	byTarget := items(t, c.ok(http.MethodGet, apiPrefix+"/audit?target="+target, nil))
	require.Len(t, byTarget, 1)
	require.Empty(t, items(t, c.ok(http.MethodGet, apiPrefix+"/audit?until=2000-01-01T00:00:00Z", nil)))
	require.Len(t, items(t, c.ok(http.MethodGet, apiPrefix+"/audit?since=2000-01-01T00:00:00Z&action=tag.created", nil)), 3)

	for _, q := range []string{"cursor=bogus", "actor=bob", "since=yesterday", "until=1", "limit=-1"} {
		requireError(t, c.do(http.MethodGet, apiPrefix+"/audit?"+q, nil), http.StatusBadRequest, "bad_request")
	}
}

// Resource endpoints need MFA like every non-auth endpoint.
func TestResourcesNeedMFA(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	e.createUser("bob", userOpts{totpSecret: newSecret(t)})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	for _, p := range []string{"/devices", "/groups", "/tags", "/server", "/audit"} {
		requireError(t, c.do(http.MethodGet, apiPrefix+p, nil), http.StatusForbidden, "mfa_required")
	}
	requireError(t, e.client().do(http.MethodGet, apiPrefix+"/devices", nil), http.StatusUnauthorized, "unauthenticated")
}

// Resetting an owner's TOTP while the same owner is being updated: both lock
// the active owners before the target row, so neither deadlocks (which
// Postgres would answer with 40P01, a 500).
func TestResetTOTPConcurrentWithPatchUser(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	alice, _ := e.signedIn("alice", "owner")
	alice2 := e.client()
	require.Equal(t, http.StatusOK, alice2.login("alice", goodPassword).Code)
	bobID := e.createUser("bob", userOpts{role: "owner", totpRequired: true})
	for i := range 40 {
		var codes [2]int
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			codes[0] = alice.do(http.MethodPatch, apiPrefix+"/users/"+bobID.String(),
				map[string]any{"display_name": fmt.Sprintf("Bob %d", i)}).Code
		}()
		go func() {
			defer wg.Done()
			codes[1] = alice2.do(http.MethodPost, apiPrefix+"/users/"+bobID.String()+"/reset-totp", nil).Code
		}()
		wg.Wait()
		require.Equal(t, [2]int{http.StatusOK, http.StatusOK}, codes, "round %d", i)
	}
}
