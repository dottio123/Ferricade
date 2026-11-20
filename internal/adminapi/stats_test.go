package adminapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestHistoryEndpoint(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	now := e.clock.Now()
	slot := now.Add(-2 * time.Hour).Truncate(5 * time.Minute)
	_, err := e.d.Pool.Exec(context.Background(),
		`INSERT INTO fleet_snapshots (at, approved, online, pending, sessions) VALUES ($1, 4, 3, 1, 2)`, slot)
	require.NoError(t, err)

	body := c.ok(http.MethodGet, apiPrefix+"/stats/history?range=24h", nil)
	require.Equal(t, "24h", body["range"])
	require.EqualValues(t, 300, body["step_seconds"])
	pts := body["points"].([]any)
	require.Len(t, pts, 1)
	p := pts[0].(map[string]any)
	require.Equal(t, slot.Format(time.RFC3339), p["at"])
	require.EqualValues(t, 4, p["approved"])
	require.EqualValues(t, 3, p["online"])
	require.EqualValues(t, 1, p["pending"])
	require.EqualValues(t, 2, p["sessions"])

	body = c.ok(http.MethodGet, apiPrefix+"/stats/history?range=7d", nil)
	require.EqualValues(t, 3600, body["step_seconds"])
	body = c.ok(http.MethodGet, apiPrefix+"/stats/history?range=30d", nil)
	require.EqualValues(t, 21600, body["step_seconds"])

	for _, q := range []string{"", "?range=1y", "?range=24H"} {
		requireError(t, c.do(http.MethodGet, apiPrefix+"/stats/history"+q, nil), http.StatusBadRequest, codeBadRequest)
	}
}

func TestHistoryEndpointRequiresSession(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	rec := e.client().do(http.MethodGet, apiPrefix+"/stats/history?range=24h", nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSummaryEndpoint(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("alice", "admin")
	ctx := context.Background()
	now := e.clock.Now()
	var gid string
	require.NoError(t, e.d.Pool.QueryRow(ctx, `INSERT INTO device_groups (name) VALUES ('HQ') RETURNING id::text`).Scan(&gid))
	ins := func(rid, state, os, ver string, group any, last time.Time) {
		_, err := e.d.Pool.Exec(ctx,
			`INSERT INTO devices (server_id, rustdesk_id, uuid, state, os, client_version, group_id, first_seen_at, last_seen_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8, $8)`, srv.ID, rid, "u"+rid, state, os, ver, group, last)
		require.NoError(t, err)
	}
	ins("100000001", "approved", "windows / Windows 11", "1.5.0", gid, now)
	ins("100000002", "approved", "linux / Debian", "1.4.0", nil, now.Add(-10*24*time.Hour))
	ins("100000003", "pending", "", "", nil, now.Add(-48*time.Hour))
	e.d.Tracker.Beat("100000001", nil)

	// Summaries are computed from the stored thresholds.
	owner, _ := e.signedIn("bob", "owner")
	owner.ok(http.MethodPut, apiPrefix+"/settings/dashboard", map[string]any{"offline_days": 7, "pending_hours": 24, "min_client_version": "1.5.0"})

	body := c.ok(http.MethodGet, apiPrefix+"/stats/summary", nil)
	require.Equal(t, now.Format(time.RFC3339), body["generated_at"])
	require.Equal(t, map[string]any{"approved": 2.0, "pending": 1.0, "rejected": 0.0, "archived": 0.0, "online": 1.0}, body["devices"])
	require.Equal(t, map[string]any{"active": 0.0}, body["sessions"])
	require.Equal(t, map[string]any{"open": 0.0}, body["alerts"])
	require.Len(t, body["os"], 2)
	require.Len(t, body["versions"], 2)
	groups := body["groups"].([]any)
	require.Len(t, groups, 2)
	require.Equal(t, map[string]any{"id": gid, "name": "HQ", "online": 1.0, "total": 1.0}, groups[0])
	require.Equal(t, map[string]any{"id": nil, "name": "Ungrouped", "online": 0.0, "total": 1.0}, groups[1])
	var kinds []string
	for _, a := range body["attention"].([]any) {
		kinds = append(kinds, a.(map[string]any)["kind"].(string))
	}
	require.Equal(t, []string{"pending_long", "offline_long", "outdated_client"}, kinds)
}

func TestSummaryEndpointNilTracker(t *testing.T) {
	e := newEnv(t, func(d *Deps) { d.Tracker = nil })
	srv := e.markSetupComplete()
	c, _ := e.signedIn("alice", "admin")
	_, err := e.d.Pool.Exec(context.Background(),
		`INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, '1', 'u', 'approved')`, srv.ID)
	require.NoError(t, err)
	body := c.ok(http.MethodGet, apiPrefix+"/stats/summary", nil)
	require.EqualValues(t, 0, body["devices"].(map[string]any)["online"])
}

func TestSummaryRequiresSession(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	require.Equal(t, http.StatusUnauthorized, e.client().do(http.MethodGet, apiPrefix+"/stats/summary", nil).Code)
	require.Equal(t, http.StatusUnauthorized, e.client().do(http.MethodGet, apiPrefix+"/settings/dashboard", nil).Code)
}

func TestFleetMapEndpoint(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("fleet", "admin")
	ctx := context.Background()
	var group string
	require.NoError(t, e.d.Pool.QueryRow(ctx, `INSERT INTO device_groups (name) VALUES ('HQ') RETURNING id::text`).Scan(&group))
	insert := func(rid, alias, hostname string, groupID any, state string) string {
		var id string
		err := e.d.Pool.QueryRow(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, alias, hostname, group_id, state)
			VALUES ($1,$2,$3,$4,$5,$6::uuid,$7) RETURNING id::text`, srv.ID, rid, "u"+rid, alias, hostname, groupID, state).Scan(&id)
		require.NoError(t, err)
		return id
	}
	alertID := insert("fleet-alert", "Alpha", "", group, "approved")
	insert("fleet-host", "", "Beta", nil, "approved")
	insert("fleet-rid", "", "", nil, "approved")
	insert("fleet-pending", "Pending", "", nil, "pending")
	insert("fleet-rejected", "Rejected", "", nil, "rejected")
	insert("fleet-archived", "Archived", "", nil, "archived")
	_, err := e.d.Pool.Exec(ctx, `INSERT INTO device_alerts (device_id, kind) VALUES ($1, 'uuid_mismatch')`, alertID)
	require.NoError(t, err)
	e.d.Tracker.Beat("fleet-alert", nil)
	body := c.ok(http.MethodGet, apiPrefix+"/stats/fleet-map", nil)
	require.Equal(t, e.clock.Now().Format(time.RFC3339), body["generated_at"])
	require.Equal(t, false, body["truncated"])
	devices := body["devices"].([]any)
	require.Len(t, devices, 3)
	first := devices[0].(map[string]any)
	require.Equal(t, "Alpha", first["name"])
	require.Equal(t, group, first["group_id"])
	require.Equal(t, "alert", first["status"], "alert takes precedence over online")
	require.Equal(t, "Beta", devices[1].(map[string]any)["name"])
	require.Equal(t, "fleet-rid", devices[2].(map[string]any)["name"])
}

func TestFleetMapRequiresSession(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	require.Equal(t, http.StatusUnauthorized, e.client().do(http.MethodGet, apiPrefix+"/stats/fleet-map", nil).Code)
}

func TestFleetMapUserMasksHiddenGroup(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	owner, _ := e.signedIn("fleet-owner", "owner")
	user, userID := e.signedIn("fleet-user", "user")
	groupA := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Visible"})["id"].(string)
	groupB := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Hidden"})["id"].(string)
	var visibleID, hiddenID string
	for _, item := range []struct{ rid, group string }{{"fleet-user-a", groupA}, {"fleet-user-b", groupB}} {
		err := e.d.Pool.QueryRow(context.Background(), `INSERT INTO devices (server_id, rustdesk_id, uuid, state, group_id)
			VALUES ($1,$2,$3,'approved',$4::uuid) RETURNING id::text`, srv.ID, item.rid, "u"+item.rid, item.group).Scan(map[string]*string{groupA: &visibleID, groupB: &hiddenID}[item.group])
		require.NoError(t, err)
	}
	owner.ok(http.MethodPut, apiPrefix+"/users/"+userID.String()+"/grants", map[string]any{
		"group_ids": []string{groupA}, "device_ids": []string{hiddenID},
	})
	body := user.ok(http.MethodGet, apiPrefix+"/stats/fleet-map", nil)
	devices := body["devices"].([]any)
	require.Len(t, devices, 2)
	byID := map[string]map[string]any{}
	for _, item := range devices {
		device := item.(map[string]any)
		byID[device["id"].(string)] = device
	}
	require.Equal(t, groupA, byID[visibleID]["group_id"])
	require.Nil(t, byID[hiddenID]["group_id"], "an individually granted device must not reveal its ungranted group")
}

func TestFleetMapTruncatesAt2000(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("fleet-cap", "admin")
	_, err := e.d.Pool.Exec(context.Background(), `INSERT INTO devices (server_id, rustdesk_id, uuid, state)
		SELECT $1, 'fleet-cap-' || n, 'u-fleet-cap-' || n, 'approved' FROM generate_series(1, 2001) AS n`, srv.ID)
	require.NoError(t, err)
	body := c.ok(http.MethodGet, apiPrefix+"/stats/fleet-map", nil)
	require.Equal(t, true, body["truncated"])
	require.Len(t, body["devices"], 2000)
}

func TestThresholdsValidateAndAudit(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("alice", "owner")

	got := owner.ok(http.MethodGet, apiPrefix+"/settings/dashboard", nil)
	require.Equal(t, map[string]any{"offline_days": 7.0, "pending_hours": 24.0, "min_client_version": ""}, got)

	for field, body := range map[string]map[string]any{
		"offline_days":       {"offline_days": 0, "pending_hours": 24, "min_client_version": ""},
		"pending_hours":      {"offline_days": 7, "pending_hours": 721, "min_client_version": ""},
		"min_client_version": {"offline_days": 7, "pending_hours": 24, "min_client_version": "v1"},
	} {
		rec := owner.do(http.MethodPut, apiPrefix+"/settings/dashboard", body)
		requireError(t, rec, http.StatusBadRequest, "bad_request")
		require.Contains(t, decodeBody(t, rec)["error"].(map[string]any)["message"], field)
	}
	requireError(t, owner.do(http.MethodPut, apiPrefix+"/settings/dashboard", map[string]any{"offline_days": 3, "pending_hours": 24}), http.StatusBadRequest, "bad_request")
	requireError(t, owner.do(http.MethodPut, apiPrefix+"/settings/dashboard", map[string]any{"offline_days": 3, "pending_hours": 24, "min_client_version": "", "x": 1}), http.StatusBadRequest, "bad_request")
	require.Empty(t, e.auditEntries("settings.dashboard_updated"), "failures are not audited")

	put := map[string]any{"offline_days": 14, "pending_hours": 48, "min_client_version": "1.5.0"}
	require.Equal(t, mapNums(put), owner.ok(http.MethodPut, apiPrefix+"/settings/dashboard", put))
	require.Equal(t, mapNums(put), owner.ok(http.MethodGet, apiPrefix+"/settings/dashboard", nil))

	entries := e.auditEntries("settings.dashboard_updated")
	require.Len(t, entries, 1)
	require.Equal(t, map[string]any{
		"before": map[string]any{"offline_days": 7.0, "pending_hours": 24.0, "min_client_version": ""},
		"after":  map[string]any{"offline_days": 14.0, "pending_hours": 48.0, "min_client_version": "1.5.0"},
	}, entries[0].Details)
}

// mapNums turns the ints of a request body into float64, as a decoded response has them.
func mapNums(m map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		if i, ok := v.(int); ok {
			v = float64(i)
		}
		out[k] = v
	}
	return out
}

func TestThresholdsOwnerOnly(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	admin, _ := e.signedIn("carol", "admin")
	body := map[string]any{"offline_days": 3, "pending_hours": 5, "min_client_version": ""}
	requireError(t, admin.do(http.MethodPut, apiPrefix+"/settings/dashboard", body), http.StatusForbidden, "forbidden")
	got := admin.ok(http.MethodGet, apiPrefix+"/settings/dashboard", nil)
	require.EqualValues(t, 7, got["offline_days"], "any admin can read")
	require.Empty(t, e.auditEntries("settings.dashboard_updated"))
}
