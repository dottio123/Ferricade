package devices_test

import (
	"context"
	"fmt"
	"net/netip"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store/db"
)

var adminIP = netip.MustParseAddr("203.0.113.5")

// actor creates an admin user and returns it as an Actor.
func (f *fixture) actor(t *testing.T) devices.Actor {
	t.Helper()
	u, err := db.New(f.pool).CreateUser(context.Background(), db.CreateUserParams{
		Username: "admin-" + uuid.NewString()[:8], Role: "admin", PasswordHash: ptr("x"),
	})
	require.NoError(t, err)
	return devices.Actor{UserID: u.ID, IP: adminIP}
}

func ptr[T any](v T) *T { return &v }

func TestDeviceTransitions(t *testing.T) {
	f := newFixture(t, 500)
	a := f.actor(t)
	ctx := context.Background()
	f.enroll(t, "dev")
	id := f.device(t, "dev").ID

	states := []string{devices.StatePending, devices.StateApproved, devices.StateRejected, devices.StateArchived}
	allowed := map[[2]string]string{
		{devices.StatePending, devices.StateApproved}:  "device.approved",
		{devices.StatePending, devices.StateRejected}:  "device.rejected",
		{devices.StateApproved, devices.StateArchived}: "device.archived",
		{devices.StateRejected, devices.StateApproved}: "device.approved",
		{devices.StateArchived, devices.StateApproved}: "device.restored",
		{devices.StateRejected, devices.StatePending}:  "device.reopened",
		{devices.StateApproved, devices.StatePending}:  "device.reopened",
	}
	for _, from := range states {
		for _, to := range states {
			t.Run(from+"->"+to, func(t *testing.T) {
				f.setState(t, "dev", from)
				_, err := f.pool.Exec(ctx, `UPDATE devices SET approved_by = NULL, approved_at = NULL WHERE id = $1`, id)
				require.NoError(t, err)
				before := len(f.audits(t, ""))

				err = f.svc.Transition(ctx, a, id, to)
				action, ok := allowed[[2]string{from, to}]
				if !ok {
					require.ErrorIs(t, err, devices.ErrBadTransition)
					require.Equal(t, from, f.device(t, "dev").State, "state unchanged")
					require.Len(t, f.audits(t, ""), before, "nothing audited")
					return
				}
				require.NoError(t, err)
				d, err := f.svc.Get(ctx, id)
				require.NoError(t, err)
				require.Equal(t, to, d.State)
				if to == devices.StateApproved {
					require.Equal(t, &a.UserID, d.ApprovedBy, "approval sets approved_by")
					require.NotNil(t, d.ApprovedAt)
					require.Equal(t, t0, d.ApprovedAt.UTC())
				} else {
					require.Nil(t, d.ApprovedBy)
					require.Nil(t, d.ApprovedAt)
				}
				got := f.audits(t, action)
				require.NotEmpty(t, got)
				require.Equal(t, &a.UserID, got[0].ActorUserID)
				require.Equal(t, adminIP, got[0].ActorIP)
				require.Equal(t, id.String(), got[0].TargetID)
				require.Equal(t, map[string]any{"from": from, "to": to}, got[0].Details)
			})
		}
	}

	// from narrows the allowed moves: a restore needs an archived device.
	f.setState(t, "dev", devices.StatePending)
	require.ErrorIs(t, f.svc.Transition(ctx, a, id, devices.StateApproved, devices.StateArchived), devices.ErrBadTransition)
	require.NoError(t, f.svc.Transition(ctx, a, id, devices.StateApproved, devices.StatePending, devices.StateRejected))
	// A reopen (the undo of a reject) needs a rejected device.
	require.ErrorIs(t, f.svc.Transition(ctx, a, id, devices.StatePending, devices.StateRejected), devices.ErrBadTransition)

	require.ErrorIs(t, f.svc.Transition(ctx, a, uuid.New(), devices.StateApproved), devices.ErrNotFound)
}

func TestDeviceListFilters(t *testing.T) {
	f := newFixture(t, 500)
	a := f.actor(t)
	ctx := context.Background()
	tags := &devices.Tags{Pool: f.pool}
	groups := &devices.Groups{Pool: f.pool}

	// Enrolled out of order: the list is ordered by rustdesk_id.
	for _, id := range []string{"dev-d", "dev-b", "dev-a", "dev-c", "dev-e"} {
		f.enroll(t, id)
	}
	f.sysinfo(t, wire.SysinfoRequest{ID: "dev-a", UUID: uuidA, Hostname: "Kitchen-PC", OS: "Windows 11 Pro", Username: "anna"})
	f.sysinfo(t, wire.SysinfoRequest{ID: "dev-b", UUID: uuidA, Hostname: "build-01", OS: "Linux / Ubuntu", Username: "ci"})
	f.sysinfo(t, wire.SysinfoRequest{ID: "dev-c", UUID: uuidA, Hostname: "mac-mini", OS: "macOS 14", Username: "bob_x"})
	f.setState(t, "dev-b", devices.StateApproved)
	f.setState(t, "dev-c", devices.StateApproved)
	f.setState(t, "dev-e", devices.StateRejected)

	tag, err := tags.Create(ctx, a, "servers", 0xFF1E88E5)
	require.NoError(t, err)
	grp, err := groups.Create(ctx, a, "Lab", nil)
	require.NoError(t, err)
	_, err = f.svc.Update(ctx, a, f.device(t, "dev-b").ID, devices.Patch{TagIDs: &[]uuid.UUID{tag.ID}})
	require.NoError(t, err)
	_, err = f.svc.Update(ctx, a, f.device(t, "dev-c").ID, devices.Patch{TagIDs: &[]uuid.UUID{tag.ID}, GroupID: ptr(&grp.ID)})
	require.NoError(t, err)
	_, err = f.svc.Update(ctx, a, f.device(t, "dev-d").ID, devices.Patch{Alias: ptr("Front desk")})
	require.NoError(t, err)

	online := map[string]bool{"dev-a": true, "dev-c": true}
	isOnline := func(id string) bool { return online[id] }
	list := func(fl devices.Filter) []string {
		t.Helper()
		got, next, err := f.svc.List(ctx, fl, isOnline)
		require.NoError(t, err)
		require.Empty(t, next)
		ids := []string{}
		for _, d := range got {
			ids = append(ids, d.RustdeskID)
		}
		return ids
	}

	require.Equal(t, []string{"dev-a", "dev-b", "dev-c", "dev-d", "dev-e"}, list(devices.Filter{}))
	require.Equal(t, []string{"dev-a", "dev-d"}, list(devices.Filter{State: devices.StatePending}))
	require.Equal(t, []string{"dev-b", "dev-c"}, list(devices.Filter{TagID: &tag.ID}))
	require.Equal(t, []string{"dev-c"}, list(devices.Filter{GroupID: &grp.ID}))
	require.Equal(t, []string{"dev-a", "dev-b", "dev-d", "dev-e"}, list(devices.Filter{Ungrouped: true}))
	// Ungrouped uses the same state and keyset paging filters as the rest of the list.
	var ungroupedPages [][]string
	ungroupedCursor := ""
	for {
		got, next, err := f.svc.List(ctx, devices.Filter{Ungrouped: true, State: devices.StatePending, Limit: 1, Cursor: ungroupedCursor}, isOnline)
		require.NoError(t, err)
		ids := []string{}
		for _, d := range got {
			ids = append(ids, d.RustdeskID)
		}
		ungroupedPages = append(ungroupedPages, ids)
		if next == "" {
			break
		}
		ungroupedCursor = next
	}
	require.Len(t, ungroupedPages, 2, "the state-filtered ungrouped result spans multiple pages")
	require.ElementsMatch(t, []string{"dev-a", "dev-d"}, []string{
		ungroupedPages[0][0], ungroupedPages[1][0],
	})
	require.Equal(t, []string{"dev-a"}, list(devices.Filter{OS: "windows"}), "os is a case-insensitive prefix")
	require.Empty(t, list(devices.Filter{OS: "ubuntu"}))
	require.Equal(t, []string{"dev-a"}, list(devices.Filter{Q: "KITCHEN"}), "q matches hostname")
	require.Equal(t, []string{"dev-d"}, list(devices.Filter{Q: "front"}), "q matches alias")
	require.Equal(t, []string{"dev-b"}, list(devices.Filter{Q: "ci"}), "q matches username")
	require.Equal(t, []string{"dev-e"}, list(devices.Filter{Q: "v-e"}), "q matches rustdesk_id")
	require.Empty(t, list(devices.Filter{Q: "%"}), "LIKE metacharacters are literal")
	require.Equal(t, []string{"dev-c"}, list(devices.Filter{Q: "b_x"}), "underscore is literal")
	require.Equal(t, []string{"dev-a", "dev-c"}, list(devices.Filter{Online: ptr(true)}))
	require.Equal(t, []string{"dev-b", "dev-d", "dev-e"}, list(devices.Filter{Online: ptr(false)}))
	require.Equal(t, []string{"dev-c"}, list(devices.Filter{State: devices.StateApproved, Online: ptr(true), TagID: &tag.ID}))

	// Items carry their tags.
	got, _, err := f.svc.List(ctx, devices.Filter{TagID: &tag.ID}, isOnline)
	require.NoError(t, err)
	require.Equal(t, []devices.Tag{tag}, got[0].Tags)

	// Pagination by cursor.
	var pages [][]string
	cursor := ""
	for {
		got, next, err := f.svc.List(ctx, devices.Filter{Limit: 2, Cursor: cursor}, isOnline)
		require.NoError(t, err)
		var ids []string
		for _, d := range got {
			ids = append(ids, d.RustdeskID)
		}
		pages = append(pages, ids)
		if next == "" {
			break
		}
		cursor = next
	}
	require.Equal(t, [][]string{{"dev-a", "dev-b"}, {"dev-c", "dev-d"}, {"dev-e"}}, pages)

	// With the online filter a page may come back short, but the cursor
	// still walks the whole list.
	got, next, err := f.svc.List(ctx, devices.Filter{Limit: 2, Online: ptr(true)}, isOnline)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.NotEmpty(t, next)

	_, _, err = f.svc.List(ctx, devices.Filter{Cursor: "not-a-cursor"}, isOnline)
	require.ErrorIs(t, err, devices.ErrInvalidCursor)
}

func TestDeviceListIncludesGrantedSubgroupsWithKeysetPaging(t *testing.T) {
	f := newFixture(t, 500)
	actor := f.actor(t)
	ctx := context.Background()
	groups := &devices.Groups{Pool: f.pool}
	a, err := groups.Create(ctx, actor, "A", nil)
	require.NoError(t, err)
	a1, err := groups.Create(ctx, actor, "A1", &a.ID)
	require.NoError(t, err)
	a1a, err := groups.Create(ctx, actor, "A1a", &a1.ID)
	require.NoError(t, err)
	for i, group := range []uuid.UUID{a.ID, a1.ID, a1a.ID} {
		id := fmt.Sprintf("tree-%d", i)
		f.enroll(t, id)
		_, err := f.svc.Update(ctx, actor, f.device(t, id).ID, devices.Patch{GroupID: ptr(&group)})
		require.NoError(t, err)
		f.setState(t, id, devices.StateApproved)
	}
	list := func(filter devices.Filter) []string {
		t.Helper()
		got, _, err := f.svc.List(ctx, filter, nil)
		require.NoError(t, err)
		ids := make([]string, len(got))
		for i, d := range got {
			ids[i] = d.RustdeskID
		}
		return ids
	}
	require.Equal(t, []string{"tree-0"}, list(devices.Filter{GroupID: &a.ID}))
	var paged []string
	cursor := ""
	for {
		got, next, err := f.svc.List(ctx, devices.Filter{GroupID: &a.ID, Subgroups: true, Sort: "name", Limit: 2, Cursor: cursor}, nil)
		require.NoError(t, err)
		for _, d := range got {
			paged = append(paged, d.RustdeskID)
		}
		if next == "" {
			break
		}
		cursor = next
	}
	require.Equal(t, []string{"tree-0", "tree-1", "tree-2"}, paged)

	user, err := db.New(f.pool).CreateUser(ctx, db.CreateUserParams{Username: "subgroup-user-" + uuid.NewString()[:8], Role: "user", PasswordHash: ptr("x")})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO user_grants (user_id, group_id) VALUES ($1, $2), ($1, $3)`, user.ID, a.ID, a1.ID)
	require.NoError(t, err)
	scoped, _, err := f.svc.List(ctx, devices.Filter{GroupID: &a.ID, Subgroups: true, ScopeUser: &user.ID}, nil)
	require.NoError(t, err)
	// Subgroup expansion follows only groups explicitly granted to the User.
	require.Len(t, scoped, 2)
	require.Equal(t, []string{"tree-0", "tree-1"}, []string{scoped[0].RustdeskID, scoped[1].RustdeskID})
}

func TestUpdateDeviceTags(t *testing.T) {
	f := newFixture(t, 500)
	a := f.actor(t)
	ctx := context.Background()
	tags := &devices.Tags{Pool: f.pool}
	f.enroll(t, "dev")
	id := f.device(t, "dev").ID

	var tg []devices.Tag
	for i, name := range []string{"alpha", "beta", "gamma"} {
		tag, err := tags.Create(ctx, a, name, int64(i))
		require.NoError(t, err)
		tg = append(tg, tag)
	}

	d, err := f.svc.Update(ctx, a, id, devices.Patch{TagIDs: &[]uuid.UUID{tg[1].ID, tg[0].ID, tg[0].ID}})
	require.NoError(t, err)
	require.Equal(t, []devices.Tag{tg[0], tg[1]}, d.Tags)

	d, err = f.svc.Update(ctx, a, id, devices.Patch{TagIDs: &[]uuid.UUID{tg[2].ID, tg[1].ID}, Note: ptr("rack 4")})
	require.NoError(t, err)
	require.Equal(t, []devices.Tag{tg[1], tg[2]}, d.Tags, "TagIDs replace the set")
	require.Equal(t, "rack 4", d.Note)

	got := f.audits(t, "device.updated")
	require.Len(t, got, 2)
	require.Equal(t, &a.UserID, got[0].ActorUserID)
	require.Equal(t, id.String(), got[0].TargetID)
	sorted := func(ts ...devices.Tag) []any {
		var out []any
		for _, t := range ts {
			out = append(out, t.ID.String())
		}
		return out
	}
	require.Equal(t, map[string]any{
		"before": map[string]any{"tag_ids": sortedStrings(sorted(tg[0], tg[1])), "note": ""},
		"after":  map[string]any{"tag_ids": sortedStrings(sorted(tg[1], tg[2])), "note": "rack 4"},
	}, got[0].Details)

	// An empty set clears the tags; an unknown tag is refused and changes nothing.
	d, err = f.svc.Update(ctx, a, id, devices.Patch{TagIDs: &[]uuid.UUID{}})
	require.NoError(t, err)
	require.Empty(t, d.Tags)
	_, err = f.svc.Update(ctx, a, id, devices.Patch{TagIDs: &[]uuid.UUID{tg[0].ID, uuid.New()}})
	var input devices.InputError
	require.ErrorAs(t, err, &input)
	d, err = f.svc.Get(ctx, id)
	require.NoError(t, err)
	require.Empty(t, d.Tags)

	_, err = f.svc.Update(ctx, a, id, devices.Patch{GroupID: ptr(ptr(uuid.New()))})
	require.ErrorAs(t, err, &input, "unknown group")
	_, err = f.svc.Update(ctx, a, uuid.New(), devices.Patch{Note: ptr("x")})
	require.ErrorIs(t, err, devices.ErrNotFound)

	// Deleting a tag detaches it.
	_, err = f.svc.Update(ctx, a, id, devices.Patch{TagIDs: &[]uuid.UUID{tg[0].ID}})
	require.NoError(t, err)
	require.NoError(t, tags.Delete(ctx, a, tg[0].ID))
	d, err = f.svc.Get(ctx, id)
	require.NoError(t, err)
	require.Empty(t, d.Tags)
}

func sortedStrings(v []any) []any {
	for i := range v {
		for j := i + 1; j < len(v); j++ {
			if fmt.Sprint(v[j]) < fmt.Sprint(v[i]) {
				v[i], v[j] = v[j], v[i]
			}
		}
	}
	return v
}

func TestResolveAlertAcceptsNewUUID(t *testing.T) {
	f := newFixture(t, 500)
	a := f.actor(t)
	ctx := context.Background()
	f.enroll(t, "dev")
	id := f.device(t, "dev").ID
	f.heartbeat(t, "dev", uuidB) // reinstalled client: uuid mismatch

	d, err := f.svc.Get(ctx, id)
	require.NoError(t, err)
	require.Equal(t, uuidA, d.UUID)
	require.Len(t, d.OpenAlerts, 1)
	alert := d.OpenAlerts[0]
	require.Equal(t, "uuid_mismatch", alert.Kind)
	require.Equal(t, uuidB, alert.SeenUUID)
	require.Equal(t, clientIP.String(), alert.IP)

	require.ErrorIs(t, f.svc.ResolveAlert(ctx, a, uuid.New(), alert.ID, true), devices.ErrNotFound, "alert of another device")
	require.NoError(t, f.svc.ResolveAlert(ctx, a, id, alert.ID, true))
	require.ErrorIs(t, f.svc.ResolveAlert(ctx, a, id, alert.ID, true), devices.ErrNotFound, "already resolved")

	d, err = f.svc.Get(ctx, id)
	require.NoError(t, err)
	require.Equal(t, uuidB, d.UUID, "re-pinned to the seen uuid")
	require.Empty(t, d.OpenAlerts)
	require.Equal(t, 1, f.count(t, `SELECT count(*) FROM device_alerts WHERE resolved_by = $1 AND resolved_at = $2`, a.UserID, t0))

	// The client with the new uuid is now trusted.
	require.Equal(t, wire.HeartbeatResponse{Sysinfo: true}, f.heartbeat(t, "dev", uuidB))
	f.sysinfo(t, wire.SysinfoRequest{ID: "dev", UUID: uuidB, Hostname: "new-host"})
	require.Equal(t, "new-host", f.device(t, "dev").Hostname)

	got := f.audits(t, "device.alert_resolved")
	require.Len(t, got, 1)
	require.Equal(t, map[string]any{
		"alert_id": alert.ID.String(), "kind": "uuid_mismatch", "action": "accept_new_uuid",
		"old_uuid": uuidA, "new_uuid": uuidB,
	}, got[0].Details)

	// Dismissing leaves the pin alone.
	f.heartbeat(t, "dev", uuidA)
	d, err = f.svc.Get(ctx, id)
	require.NoError(t, err)
	require.Len(t, d.OpenAlerts, 1)
	require.NoError(t, f.svc.ResolveAlert(ctx, a, id, d.OpenAlerts[0].ID, false))
	d, err = f.svc.Get(ctx, id)
	require.NoError(t, err)
	require.Equal(t, uuidB, d.UUID)
	require.Empty(t, d.OpenAlerts)
	require.Equal(t, "dismiss", f.audits(t, "device.alert_resolved")[0].Details["action"])
}

func TestMoveGroupUnderDescendantRefused(t *testing.T) {
	f := newFixture(t, 500)
	ac := f.actor(t)
	ctx := context.Background()
	groups := &devices.Groups{Pool: f.pool}

	a, err := groups.Create(ctx, ac, "a", nil)
	require.NoError(t, err)
	b, err := groups.Create(ctx, ac, "b", &a.ID)
	require.NoError(t, err)
	c, err := groups.Create(ctx, ac, "c", &b.ID)
	require.NoError(t, err)

	_, err = groups.Move(ctx, ac, a.ID, &c.ID)
	require.ErrorIs(t, err, devices.ErrCycle)
	_, err = groups.Move(ctx, ac, a.ID, &a.ID)
	require.ErrorIs(t, err, devices.ErrCycle, "under itself")
	_, err = groups.Move(ctx, ac, b.ID, &c.ID)
	require.ErrorIs(t, err, devices.ErrCycle)

	moved, err := groups.Move(ctx, ac, c.ID, nil)
	require.NoError(t, err)
	require.Nil(t, moved.ParentID)
	_, err = groups.Move(ctx, ac, a.ID, &c.ID)
	require.NoError(t, err, "c is no longer a descendant of a")

	tree, err := groups.Tree(ctx)
	require.NoError(t, err)
	require.Len(t, tree, 1)
	require.Equal(t, "c", tree[0].Name)
	require.Equal(t, "a", tree[0].Children[0].Name)
	require.Equal(t, "b", tree[0].Children[0].Children[0].Name)
	require.Len(t, f.audits(t, "group.moved"), 2)
}

func TestDeleteDevice(t *testing.T) {
	f := newFixture(t, 500)
	a := f.actor(t)
	ctx := context.Background()
	f.enroll(t, "dev", "other")
	f.sysinfo(t, wire.SysinfoRequest{ID: "dev", UUID: uuidA, Hostname: "dev-host"})
	f.setState(t, "dev", devices.StateApproved)
	id := f.device(t, "dev").ID
	otherID := f.device(t, "other").ID
	_, err := f.pool.Exec(ctx, `UPDATE devices SET alias = 'Front desk' WHERE id = $1`, id)
	require.NoError(t, err)
	f.heartbeat(t, "dev", uuidB) // an open uuid_mismatch alert
	var tagID uuid.UUID
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO tags (name) VALUES ('lab') RETURNING id`).Scan(&tagID))
	for _, dev := range []uuid.UUID{id, otherID} {
		_, err = f.pool.Exec(ctx, `INSERT INTO device_tags (device_id, tag_id) VALUES ($1, $2)`, dev, tagID)
		require.NoError(t, err)
		for i := range 2 {
			_, err = f.pool.Exec(ctx, `INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at)
				VALUES ($1, $2, now(), now())`, dev, i+1)
			require.NoError(t, err)
		}
	}

	require.NoError(t, f.svc.Delete(ctx, a, id))

	require.Zero(t, f.count(t, `SELECT count(*) FROM devices WHERE id = $1`, id))
	require.Zero(t, f.count(t, `SELECT count(*) FROM remote_sessions WHERE device_id = $1`, id))
	require.Zero(t, f.count(t, `SELECT count(*) FROM device_alerts WHERE device_id = $1`, id))
	require.Zero(t, f.count(t, `SELECT count(*) FROM device_tags WHERE device_id = $1`, id))
	require.Equal(t, 2, f.count(t, `SELECT count(*) FROM remote_sessions WHERE device_id = $1`, otherID), "other devices keep theirs")
	require.Equal(t, 1, f.count(t, `SELECT count(*) FROM tags`), "the tag itself stays")

	got := f.audits(t, "device.deleted")
	require.Len(t, got, 1)
	require.Equal(t, &a.UserID, got[0].ActorUserID)
	require.Equal(t, adminIP, got[0].ActorIP)
	require.Equal(t, id.String(), got[0].TargetID)
	require.Equal(t, map[string]any{
		"rustdesk_id": "dev", "hostname": "dev-host", "alias": "Front desk",
		"state": devices.StateApproved, "sessions": float64(2),
	}, got[0].Details)

	require.ErrorIs(t, f.svc.Delete(ctx, a, id), devices.ErrNotFound, "already deleted")
	require.Len(t, f.audits(t, "device.deleted"), 1, "a failed delete is not audited")

	// The client still reports in: it enrolls again as a new pending device.
	require.Equal(t, wire.HeartbeatResponse{Sysinfo: true}, f.heartbeat(t, "dev", uuidB))
	again := f.device(t, "dev")
	require.Equal(t, devices.StatePending, again.State)
	require.NotEqual(t, id, again.ID)
}
