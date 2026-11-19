package adminapi

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/events"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func ruleGroup(t *testing.T, c *client, name, pattern string) string {
	t.Helper()
	id := c.ok("POST", apiPrefix+"/groups", map[string]any{"name": name})["id"].(string)
	if pattern != "" {
		c.ok("POST", apiPrefix+"/groups/"+id+"/rules", map[string]any{"pattern": pattern})
	}
	return id
}

func TestAutoSortAPI(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	admin, _ := e.signedIn("admin", "admin")
	user, _ := e.signedIn("user", "user")
	for _, suffix := range []string{"/preview", ""} {
		t.Run("owner"+suffix, func(t *testing.T) {
			rec := owner.do("POST", apiPrefix+"/devices/auto-sort"+suffix, nil)
			require.Equal(t, 200, rec.Code, rec.Body.String())
			got := decodeBody(t, rec)
			require.Equal(t, []any{}, got["moves"])
			require.Equal(t, []any{}, got["conflicts"])
			require.Equal(t, float64(0), got["unchanged"])
		})
		for role, c := range map[string]*client{"admin": admin, "user": user} {
			t.Run(role+suffix, func(t *testing.T) {
				requireError(t, c.do("POST", apiPrefix+"/devices/auto-sort"+suffix, nil), 403, "forbidden")
			})
		}
		t.Run("csrf"+suffix, func(t *testing.T) {
			saved := owner.csrf
			owner.csrf = ""
			requireError(t, owner.do("POST", apiPrefix+"/devices/auto-sort"+suffix, nil), 403, "csrf")
			owner.csrf = saved
		})
	}
}

func TestGroupRulesAPI(t *testing.T) {
	for _, role := range []string{"owner", "admin"} {
		t.Run(role, func(t *testing.T) {
			e := newEnv(t)
			srv := e.markSetupComplete()
			c, _ := e.signedIn(role, role)
			g := ruleGroup(t, c, "IT", "")
			base := apiPrefix + "/groups/" + g + "/rules"
			for _, p := range []string{"", strings.Repeat("a", 129), "a b", "ü", "w-[1]"} {
				r := c.do("POST", base, map[string]any{"pattern": p})
				requireError(t, r, 400, "bad_request")
				require.Contains(t, r.Body.String(), "pattern")
			}
			rule := c.ok("POST", base, map[string]any{"pattern": "w-*-it-*"})
			require.Equal(t, g, rule["group_id"])
			require.NotNil(t, rule["created_by"])
			requireError(t, c.do("POST", base, map[string]any{"pattern": "W-*-IT-*"}), 409, "pattern_taken")
			for i := 1; i < 20; i++ {
				c.ok("POST", base, map[string]any{"pattern": fmt.Sprintf("p%d", i)})
			}
			r := c.do("POST", base, map[string]any{"pattern": "overflow"})
			requireError(t, r, 400, "bad_request")
			require.Contains(t, r.Body.String(), "pattern: a group can have at most 20 patterns")
			list := c.ok("GET", apiPrefix+"/group-rules", nil)
			require.Len(t, items(t, list), 20)
			require.Equal(t, "", list["next_cursor"])
			other := ruleGroup(t, c, "Other", "w-*")
			for i, state := range []string{"pending", "approved", "rejected", "archived"} {
				id := e.enroll(srv, fmt.Sprint(14400+i))
				_, err := e.d.Pool.Exec(context.Background(), "UPDATE devices SET hostname='w-sf-it-1', state=$2 WHERE id=$1", id, state)
				require.NoError(t, err)
			}
			before := len(e.auditEntries(""))
			preview := c.ok("POST", base+"/preview", map[string]any{"pattern": "w-*-it-*"})
			require.Equal(t, float64(2), preview["match_count"])
			require.Len(t, preview["matches"], 2)
			require.Len(t, preview["conflicts"], 2)
			require.Len(t, preview["conflicts"].([]any)[0].(map[string]any)["groups"], 2)
			require.Equal(t, before, len(e.auditEntries("")))
			for _, path := range []string{apiPrefix + "/groups/" + uuid.NewString() + "/rules", apiPrefix + "/groups/" + uuid.NewString() + "/rules/preview"} {
				requireError(t, c.do("POST", path, map[string]any{"pattern": "*"}), 404, "not_found")
			}
			requireError(t, c.do("DELETE", apiPrefix+"/groups/"+other+"/rules/"+rule["id"].(string), nil), 404, "not_found")
			require.Equal(t, 204, c.do("DELETE", base+"/"+rule["id"].(string), nil).Code)
			require.Len(t, e.auditEntries("group.rule_removed"), 1)
			require.Len(t, e.auditEntries("group.rule_added"), 21)
			csrf := c.csrf
			c.csrf = ""
			for _, op := range []struct{ method, path string }{{"POST", base}, {"POST", base + "/preview"}, {"DELETE", base + "/" + uuid.NewString()}} {
				require.Equal(t, 403, c.do(op.method, op.path, map[string]any{"pattern": "*"}).Code)
			}
			c.csrf = csrf
		})
	}
}

func TestApprovalGroupRules(t *testing.T) {
	for _, tt := range []struct {
		name, state string
		matches     int
		preset      bool
	}{
		{"zero", "pending", 0, false}, {"one", "pending", 1, false}, {"two", "pending", 2, false}, {"preset", "pending", 1, true}, {"restore", "archived", 1, false}, {"rejected", "rejected", 1, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			srv := e.markSetupComplete()
			c, _ := e.signedIn("owner", "owner")
			ids := []string{}
			for i := 0; i < tt.matches; i++ {
				ids = append(ids, ruleGroup(t, c, fmt.Sprint("Group", i), "w-*-it-*"))
			}
			id := e.enroll(srv, "144000001")
			path := apiPrefix + "/devices/" + id.String()
			_, err := e.d.Pool.Exec(context.Background(), "UPDATE devices SET hostname='w-sf-it-1',state=$2 WHERE id=$1", id, tt.state)
			require.NoError(t, err)
			manualID := ""
			if tt.preset {
				manualID = ruleGroup(t, c, "Manual", "")
				c.ok("PATCH", path, map[string]any{"group_id": manualID})
			}
			action := "approve"
			if tt.state == "archived" {
				action = "restore"
			}
			d := c.ok("POST", path+"/"+action, nil)
			require.Equal(t, "approved", d["state"])
			if tt.preset {
				require.Equal(t, manualID, d["group_id"])
				require.Empty(t, d["open_alerts"])
				details := e.auditEntries("device.approved")[0].Details
				require.NotContains(t, details, "group_id")
				require.NotContains(t, details, "pattern")
			} else if tt.matches == 1 && tt.state != "archived" {
				require.Equal(t, ids[0], d["group_id"])
				details := e.auditEntries("device.approved")[0].Details
				require.Equal(t, ids[0], details["group_id"])
				require.Equal(t, "w-*-it-*", details["pattern"])
			} else {
				require.Nil(t, d["group_id"])
			}
			if tt.matches == 2 && !tt.preset {
				alerts := d["open_alerts"].([]any)
				require.Len(t, alerts, 1)
				al := alerts[0].(map[string]any)
				require.Equal(t, "group_conflict", al["kind"])
				require.Len(t, al["groups"], 2)
				ruleGroup(t, c, "Third", "w-*")
				c.ok("POST", path+"/reopen", nil)
				again := c.ok("POST", path+"/approve", nil)["open_alerts"].([]any)
				require.Len(t, again, 1)
				require.Equal(t, al["id"], again[0].(map[string]any)["id"])
				require.Len(t, again[0].(map[string]any)["groups"], 3)
				resolve := path + "/alerts/" + al["id"].(string) + "/resolve"
				r := c.do("POST", resolve, map[string]any{"action": "accept_new_uuid"})
				requireError(t, r, 400, "bad_request")
				require.Contains(t, r.Body.String(), "action")
				kept := c.ok("POST", resolve, map[string]any{"action": "dismiss"})
				require.Nil(t, kept["group_id"])
				require.Empty(t, kept["open_alerts"])
				c.ok("POST", path+"/reopen", nil)
				c.ok("POST", path+"/approve", nil)
				_, err = e.d.Pool.Exec(context.Background(), "UPDATE devices SET group_id=$2 WHERE id=$1", id, ids[0])
				require.NoError(t, err)
				stillOpen := c.ok("PATCH", path, map[string]any{"alias": "keep conflict"})
				require.Len(t, stillOpen["open_alerts"], 1)
				resolved := c.ok("PATCH", path, map[string]any{"group_id": ids[0]})
				require.Empty(t, resolved["open_alerts"])
				require.Equal(t, "conflict_resolved", e.auditEntries("device.updated")[0].Details["reason"])
				_, err = e.d.Pool.Exec(context.Background(), "UPDATE devices SET group_id=NULL WHERE id=$1", id)
				require.NoError(t, err)
				c.ok("POST", path+"/reopen", nil)
				c.ok("POST", path+"/approve", nil)
				different := c.ok("PATCH", path, map[string]any{"group_id": ids[1]})
				require.Empty(t, different["open_alerts"])
				require.Equal(t, "conflict_resolved", e.auditEntries("device.updated")[0].Details["reason"])
			}
		})
	}
}

func TestRenameAfterApprovalDoesNotMove(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("owner", "owner")
	g := ruleGroup(t, c, "IT", "w-*-it-*")
	ruleGroup(t, c, "Other", "linux-*")
	id := e.enroll(srv, "144000002")
	ctx := context.Background()
	require.NoError(t, e.d.Devices.Sysinfo(ctx, srv.ID, wire.SysinfoRequest{ID: "144000002", UUID: testUUID, Hostname: "w-sf-it-1"}, deviceIP))
	c.ok("POST", apiPrefix+"/devices/"+id.String()+"/approve", nil)
	require.NoError(t, e.d.Devices.Sysinfo(ctx, srv.ID, wire.SysinfoRequest{ID: "144000002", UUID: testUUID, Hostname: "linux-1"}, deviceIP))
	require.Equal(t, g, c.ok("GET", apiPrefix+"/devices/"+id.String(), nil)["group_id"])
}

func TestConflictAlertSkipsDeletedGroup(t *testing.T) {
	e := newEnv(t)
	srv := e.markSetupComplete()
	c, _ := e.signedIn("owner", "owner")
	a := ruleGroup(t, c, "A", "*")
	ruleGroup(t, c, "B", "*")
	id := e.enroll(srv, "144000003")
	_, err := e.d.Pool.Exec(context.Background(), "UPDATE devices SET hostname='pc' WHERE id=$1", id)
	require.NoError(t, err)
	path := apiPrefix + "/devices/" + id.String()
	c.ok("POST", path+"/approve", nil)
	require.Equal(t, 204, c.do("DELETE", apiPrefix+"/groups/"+a, nil).Code)
	require.Empty(t, c.ok("GET", path, nil)["open_alerts"])
	var resolved int
	require.NoError(t, e.d.Pool.QueryRow(context.Background(), `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND kind='group_conflict' AND resolved_at IS NOT NULL`, id).Scan(&resolved))
	require.Equal(t, 1, resolved)
	r := c.do("PATCH", path, map[string]any{"group_id": a})
	requireError(t, r, 400, "bad_request")
	require.Contains(t, r.Body.String(), "group_id")
}

func TestGroupRulesStaffEvents(t *testing.T) {
	e, owner, viewer, hub, viewerID, group, _, _ := userEventsFixture(t, true)
	admin, _ := e.signedIn("admin", "admin")
	server := eventsServer(t, e, nil)
	a := openStream(t, server, admin)
	u := openStream(t, server, viewer)
	require.Equal(t, "retry: 3000", a.next(t, time.Second))
	require.Equal(t, "retry: 3000", u.next(t, time.Second))
	owner.ok("POST", apiPrefix+"/groups/"+group+"/rules", map[string]any{"pattern": "*"})
	require.Contains(t, a.waitFor(t, "event: group_rules.updated", 2*time.Second), "group_rules.updated")
	// A following visible event is an ordering barrier for the User's stream.
	hub.Publish(events.Event{Type: events.TypeDeviceOnline, DeviceID: "not-visible"})
	hub.Publish(events.Event{Type: events.TypePreferencesUpdated, UserID: viewerID})
	require.Equal(t, "event: preferences.updated", u.waitForPrefix(t, "event: ", time.Second))
}

func TestAutoSortBusyAPI(t *testing.T) {
	for _, lock := range []string{`SELECT pg_advisory_xact_lock(hashtext('ferricade.auto_sort'))`, `LOCK TABLE devices IN ROW EXCLUSIVE MODE`} {
		t.Run(lock, func(t *testing.T) {
			e := newEnv(t)
			e.markSetupComplete()
			owner, _ := e.signedIn("owner", "owner")
			ctx := context.Background()
			tx, err := e.d.Pool.Begin(ctx)
			require.NoError(t, err)
			defer tx.Rollback(ctx)
			_, err = tx.Exec(ctx, lock)
			require.NoError(t, err)
			before := len(e.auditEntries(""))
			released := make(chan struct{})
			timer := time.AfterFunc(7*time.Second, func() { _ = tx.Rollback(ctx); close(released) })
			defer func() {
				if !timer.Stop() {
					<-released
				}
			}()
			start := time.Now()
			rec := owner.do("POST", apiPrefix+"/devices/auto-sort", nil)
			requireError(t, rec, 503, "busy")
			require.Contains(t, rec.Body.String(), "auto sort could not start: devices are busy, try again")
			require.Less(t, time.Since(start), 6500*time.Millisecond)
			require.Equal(t, before, len(e.auditEntries("")))
		})
	}
}

func TestReapprovalResolvesAndAuditsConflict(t *testing.T) {
	for _, matches := range []int{0, 1} {
		t.Run(fmt.Sprint(matches), func(t *testing.T) {
			e := newEnv(t)
			srv := e.markSetupComplete()
			c, _ := e.signedIn("owner", "owner")
			a := ruleGroup(t, c, "A", "*")
			b := ruleGroup(t, c, "B", "*")
			id := e.enroll(srv, "145000001")
			_, err := e.d.Pool.Exec(context.Background(), `UPDATE devices SET hostname='pc' WHERE id=$1`, id)
			require.NoError(t, err)
			path := apiPrefix + "/devices/" + id.String()
			c.ok("POST", path+"/approve", nil)
			c.ok("POST", path+"/reopen", nil)
			_, err = e.d.Pool.Exec(context.Background(), `DELETE FROM group_rules WHERE group_id=$1 OR ($3=0 AND group_id=$2)`, b, a, matches)
			require.NoError(t, err)
			got := c.ok("POST", path+"/approve", nil)
			require.Empty(t, got["open_alerts"])
			audited := false
			for _, entry := range e.auditEntries("device.approved") {
				if entry.Details["conflict_resolved"] == true {
					audited = true
				}
			}
			require.True(t, audited, "approval must audit the conflict resolution")
		})
	}
}
