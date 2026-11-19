package store_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func TestUserGrantVisibility(t *testing.T) {
	ctx := context.Background()
	pool := store.NewTestDB(t)
	var user, other, server, root, child, grandchild, outside, direct, inherited, moved uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, role, password_hash) VALUES ('user', 'user', 'x') RETURNING id`).Scan(&user))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, role, password_hash) VALUES ('other', 'user', 'x') RETURNING id`).Scan(&other))
	requireSQLState(t, pool, "23514", `INSERT INTO users (username, role, password_hash) VALUES ('bad', 'root', 'x')`)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO servers (name, id_host) VALUES ('s', 'h') RETURNING id`).Scan(&server))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO device_groups (name) VALUES ('root') RETURNING id`).Scan(&root))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO device_groups (name, parent_id) VALUES ('child', $1) RETURNING id`, root).Scan(&child))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO device_groups (name) VALUES ('outside') RETURNING id`).Scan(&outside))
	_, err := pool.Exec(ctx, `INSERT INTO user_grants (user_id, group_id) VALUES ($1, $2)`, user, root)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO device_groups (name, parent_id) VALUES ('grandchild', $1) RETURNING id`, child).Scan(&grandchild))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, state, group_id) VALUES ($1, 'inherited', 'x', 'approved', $2) RETURNING id`, server, grandchild).Scan(&inherited))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, 'direct', 'x', 'approved') RETURNING id`, server).Scan(&direct))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, 'moved', 'x', 'approved') RETURNING id`, server).Scan(&moved))
	_, err = pool.Exec(ctx, `INSERT INTO user_grants (user_id, device_id) VALUES ($1, $2)`, user, direct)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO user_grants (user_id, device_id) VALUES ($1, $2)`, other, moved)
	require.NoError(t, err)
	visible := func() []uuid.UUID {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT visible_devices($1)`, user)
		require.NoError(t, err)
		ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		require.NoError(t, err)
		return ids
	}
	require.ElementsMatch(t, []uuid.UUID{direct, inherited}, visible())
	_, err = pool.Exec(ctx, `UPDATE devices SET group_id = $1 WHERE id = $2`, outside, inherited)
	require.NoError(t, err)
	require.Equal(t, []uuid.UUID{direct}, visible())
	_, err = pool.Exec(ctx, `UPDATE devices SET group_id = $1 WHERE id = $2`, grandchild, inherited)
	require.NoError(t, err)
	for _, state := range []string{"pending", "rejected", "archived"} {
		_, err = pool.Exec(ctx, `UPDATE devices SET state = $1 WHERE id = $2`, state, direct)
		require.NoError(t, err)
		require.Equal(t, []uuid.UUID{inherited}, visible())
	}
	_, err = pool.Exec(ctx, `UPDATE devices SET state = 'approved' WHERE id = $1`, direct)
	require.NoError(t, err)
	require.ElementsMatch(t, []uuid.UUID{direct, inherited}, visible())
	_, err = pool.Exec(ctx, `DELETE FROM devices WHERE id = $1`, direct)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE devices SET group_id = $1 WHERE id = $2`, outside, inherited)
	require.NoError(t, err)
	for _, id := range []uuid.UUID{grandchild, child, root} {
		_, err = pool.Exec(ctx, `DELETE FROM device_groups WHERE id = $1`, id)
		require.NoError(t, err)
	}
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM user_grants WHERE user_id = $1`, user).Scan(&count))
	require.Zero(t, count)
	require.Empty(t, visible())
}

func TestScopedQueriesAndNotifications(t *testing.T) {
	ctx := context.Background()
	pool := store.NewTestDB(t)
	q := db.New(pool)
	var user, server, group, child, hiddenParent, root, visible, hidden uuid.UUID
	for name, id := range map[string]*uuid.UUID{"user": &user} {
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, role, password_hash) VALUES ($1, 'user', 'x') RETURNING id`, name).Scan(id))
	}
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO servers (name, id_host) VALUES ('s', 'h') RETURNING id`).Scan(&server))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO device_groups (name) VALUES ('granted') RETURNING id`).Scan(&group))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO device_groups (name, parent_id) VALUES ('child', $1) RETURNING id`, group).Scan(&child))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO device_groups (name) VALUES ('hidden-parent') RETURNING id`).Scan(&hiddenParent))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO device_groups (name, parent_id) VALUES ('separate-root', $1) RETURNING id`, hiddenParent).Scan(&root))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, state, group_id) VALUES ($1, 'visible', 'x', 'approved', $2) RETURNING id`, server, child).Scan(&visible))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, 'hidden', 'x', 'approved') RETURNING id`, server).Scan(&hidden))
	_, err := pool.Exec(ctx, `INSERT INTO user_grants (user_id, group_id) VALUES ($1, $2), ($1, $3), ($1, $4)`, user, group, child, root)
	require.NoError(t, err)
	groups, err := q.ListVisibleGroups(ctx, user)
	require.NoError(t, err)
	require.Len(t, groups, 3)
	for _, g := range groups {
		if g.ID == root || g.ID == group {
			require.Nil(t, g.ParentID)
		}
		if g.ID == child {
			require.Equal(t, &group, g.ParentID)
		}
	}
	_, err = q.GetVisibleDevice(ctx, db.GetVisibleDeviceParams{ID: visible, UserID: user})
	require.NoError(t, err)
	_, err = q.GetVisibleDevice(ctx, db.GetVisibleDeviceParams{ID: hidden, UserID: user})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	all, err := q.ListDevices(ctx, db.ListDevicesParams{RowLimit: 10})
	require.NoError(t, err)
	nullScope, err := q.ListDevices(ctx, db.ListDevicesParams{ScopeUser: nil, RowLimit: 10})
	require.NoError(t, err)
	require.Equal(t, all, nullScope)
	scoped, err := q.ListDevices(ctx, db.ListDevicesParams{ScopeUser: &user, RowLimit: 10})
	require.NoError(t, err)
	require.Len(t, all, 2)
	require.Len(t, scoped, 1)
	require.Equal(t, visible, scoped[0].ID)
	for _, id := range []uuid.UUID{visible, hidden} {
		_, err = pool.Exec(ctx, `INSERT INTO remote_sessions (device_id, conn_id, started_at, authed_at, conn_seen_at) VALUES ($1, 1, now(), now(), now())`, id)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO device_alerts (device_id, kind) VALUES ($1, 'uuid_mismatch')`, id)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO tags (name) VALUES ('visible-tag'), ('hidden-tag')`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO device_tags (device_id, tag_id) SELECT $1, id FROM tags WHERE name = 'visible-tag'`, visible)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO device_tags (device_id, tag_id) SELECT $1, id FROM tags WHERE name = 'hidden-tag'`, hidden)
	require.NoError(t, err)
	tags, err := q.ListTags(ctx, db.ListTagsParams{ScopeUser: &user, RowLimit: 10})
	require.NoError(t, err)
	require.Len(t, tags, 1)
	require.Equal(t, "visible-tag", tags[0].Name)
	allTags, err := q.ListTags(ctx, db.ListTagsParams{RowLimit: 10})
	require.NoError(t, err)
	require.Len(t, allTags, 2)
	now := time.Now()
	sessions, err := q.ListRemoteSessions(ctx, db.ListRemoteSessionsParams{ScopeUser: &user, RowLimit: 10})
	require.NoError(t, err)
	require.Len(t, sessions, 1)
	require.Equal(t, visible, sessions[0].DeviceID)
	allSessions, err := q.ListRemoteSessions(ctx, db.ListRemoteSessionsParams{RowLimit: 10})
	require.NoError(t, err)
	require.Len(t, allSessions, 2)
	days, err := q.RemoteSessionsPerDay(ctx, db.RemoteSessionsPerDayParams{Tz: "UTC", Now: now, RangeStart: now.Add(-time.Hour), ScopeUser: &user})
	require.NoError(t, err)
	require.Len(t, days, 1)
	require.Equal(t, int64(1), days[0].Count)
	allDays, err := q.RemoteSessionsPerDay(ctx, db.RemoteSessionsPerDayParams{Tz: "UTC", Now: now, RangeStart: now.Add(-time.Hour)})
	require.NoError(t, err)
	require.Len(t, allDays, 1)
	require.Equal(t, int64(2), allDays[0].Count)
	top, err := q.RemoteSessionsTopDevices(ctx, db.RemoteSessionsTopDevicesParams{Now: now, RangeStart: now.Add(-time.Hour), ScopeUser: &user})
	require.NoError(t, err)
	require.Len(t, top, 1)
	require.Equal(t, visible, top[0].DeviceID)
	allTop, err := q.RemoteSessionsTopDevices(ctx, db.RemoteSessionsTopDevicesParams{Now: now, RangeStart: now.Add(-time.Hour)})
	require.NoError(t, err)
	require.Len(t, allTop, 2)
	devs, err := q.SummaryDevices(ctx, &user)
	require.NoError(t, err)
	require.Len(t, devs, 1)
	allDevs, err := q.SummaryDevices(ctx, nil)
	require.NoError(t, err)
	require.Len(t, allDevs, 2)
	summaryGroups, err := q.SummaryGroups(ctx, &user)
	require.NoError(t, err)
	require.Len(t, summaryGroups, 3)
	allGroups, err := q.SummaryGroups(ctx, nil)
	require.NoError(t, err)
	require.Len(t, allGroups, 4)
	alerts, err := q.SummaryOpenAlerts(ctx, &user)
	require.NoError(t, err)
	require.Len(t, alerts, 1)
	allAlerts, err := q.SummaryOpenAlerts(ctx, nil)
	require.NoError(t, err)
	require.Len(t, allAlerts, 2)
	count, err := q.CountOpenSessionsOfAllApproved(ctx, &user)
	require.NoError(t, err)
	require.Equal(t, int32(1), count)
	count, err = q.CountOpenSessionsOfAllApproved(ctx, nil)
	require.NoError(t, err)
	require.Equal(t, int32(2), count)

	conn, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer conn.Release()
	_, err = conn.Exec(ctx, `LISTEN ferricade_events`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO user_grants (user_id, device_id) VALUES ($1, $2)`, user, hidden)
	require.NoError(t, err)
	check := func(kind string) {
		t.Helper()
		wait, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		for {
			n, err := conn.Conn().WaitForNotification(wait)
			require.NoError(t, err)
			var payload map[string]any
			require.NoError(t, json.Unmarshal([]byte(n.Payload), &payload))
			if payload["kind"] == kind {
				require.Equal(t, user.String(), payload["user_id"])
				return
			}
		}
	}
	check("grants")
	require.NoError(t, q.NotifyGrantsChanged(ctx, user))
	check("grants")
	_, err = pool.Exec(ctx, `DELETE FROM user_grants WHERE user_id = $1 AND device_id = $2`, user, hidden)
	require.NoError(t, err)
	check("grants")
	_, err = pool.Exec(ctx, `INSERT INTO audit_events (actor_user_id, actor_ip, action) VALUES ($1, '192.0.2.1', 'test')`, user)
	require.NoError(t, err)
	wait, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for {
		n, err := conn.Conn().WaitForNotification(wait)
		require.NoError(t, err)
		var audit map[string]any
		require.NoError(t, json.Unmarshal([]byte(n.Payload), &audit))
		if audit["kind"] == "audit" {
			require.Equal(t, user.String(), audit["actor_user_id"])
			break
		}
	}
}
