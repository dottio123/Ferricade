package policies

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func policyTest(t *testing.T) (*Service, devices.Actor) {
	t.Helper()
	p := store.NewTestDB(t)
	var id uuid.UUID
	require.NoError(t, p.QueryRow(context.Background(), `INSERT INTO users (username, role, password_hash) VALUES ('policy-actor', 'admin', 'x') RETURNING id`).Scan(&id))
	return &Service{Pool: p}, devices.Actor{UserID: id, IP: netip.MustParseAddr("192.0.2.1")}
}

func auditCount(t *testing.T, s *Service, action string) int {
	t.Helper()
	var n int
	require.NoError(t, s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events WHERE action = $1`, action).Scan(&n))
	return n
}

func versionWithEmptyIDAllowList(settings Settings, window *Window, now time.Time) int64 {
	effective := Effective(settings, window, now)
	effective["id-whitelist"] = ""
	return Version(effective)
}

func TestPolicyCRUDAudited(t *testing.T) {
	s, a := policyTest(t)
	ctx := context.Background()
	p, err := s.Create(ctx, a, "Office", DefaultSettings())
	require.NoError(t, err)
	require.Equal(t, "Office", p.Name)
	require.Equal(t, 1, auditCount(t, s, "policy.created"))
	got, err := s.Get(ctx, p.ID)
	require.NoError(t, err)
	require.Equal(t, p.Settings, got.Settings)
	list, err := s.List(ctx)
	require.NoError(t, err)
	require.Len(t, list, 2)
	require.True(t, list[0].IsDefault)
	name := "Renamed"
	got, err = s.Update(ctx, a, p.ID, &name, nil)
	require.NoError(t, err)
	require.Equal(t, name, got.Name)
	require.Equal(t, 1, auditCount(t, s, "policy.updated"))
	require.NoError(t, s.Delete(ctx, a, p.ID))
	require.Equal(t, 1, auditCount(t, s, "policy.deleted"))
	_, err = s.Get(ctx, p.ID)
	require.ErrorIs(t, err, ErrNotFound)
	for _, action := range []string{"policy.created", "policy.updated", "policy.deleted"} {
		var details string
		require.NoError(t, s.Pool.QueryRow(ctx, `SELECT details::text FROM audit_events WHERE action = $1`, action).Scan(&details))
		require.Contains(t, details, `"name"`)
		require.NotContains(t, details, "approve-mode")
	}
}

func TestPolicyValidation(t *testing.T) {
	s, a := policyTest(t)
	bad := DefaultSettings()
	bad["unknown"] = "x"
	_, err := s.Create(context.Background(), a, "Invalid", bad)
	var validation *ValidationError
	require.ErrorAs(t, err, &validation)
	require.Equal(t, "unknown", validation.Field)
	var n int
	require.NoError(t, s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM client_policies WHERE name = 'Invalid'`).Scan(&n))
	require.Zero(t, n)
}

func TestNameTaken(t *testing.T) {
	s, a := policyTest(t)
	ctx := context.Background()
	_, err := s.Create(ctx, a, "Office", DefaultSettings())
	require.NoError(t, err)
	_, err = s.Create(ctx, a, "Office", DefaultSettings())
	require.ErrorIs(t, err, ErrNameTaken)
}

func TestDefaultPolicyProtected(t *testing.T) {
	s, a := policyTest(t)
	ctx := context.Background()
	ps, err := s.List(ctx)
	require.NoError(t, err)
	name := "Renamed"
	_, err = s.Update(ctx, a, ps[0].ID, &name, nil)
	require.ErrorIs(t, err, ErrDefaultPolicy)
	require.ErrorIs(t, s.Delete(ctx, a, ps[0].ID), ErrDefaultPolicy)
}

func TestDeletePolicyInUse(t *testing.T) {
	s, a := policyTest(t)
	ctx := context.Background()
	p, err := s.Create(ctx, a, "Used", DefaultSettings())
	require.NoError(t, err)
	var groupID uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO device_groups (name, policy_id) VALUES ('Root', $1) RETURNING id`, p.ID).Scan(&groupID))
	require.ErrorIs(t, s.Delete(ctx, a, p.ID), ErrInUse)
}

func TestPushSwitch(t *testing.T) {
	s, a := policyTest(t)
	ctx := context.Background()
	enabled, _, _, err := s.PushEnabled(ctx)
	require.NoError(t, err)
	require.False(t, enabled)
	require.NoError(t, s.SetPushEnabled(ctx, a, true))
	require.NoError(t, s.SetPushEnabled(ctx, a, true))
	require.NoError(t, s.SetPushEnabled(ctx, a, false))
	require.Equal(t, 1, auditCount(t, s, "policy_push.enabled"))
	require.Equal(t, 1, auditCount(t, s, "policy_push.disabled"))
}

func TestSetGroupPolicyAudited(t *testing.T) {
	s, a := policyTest(t)
	ctx := context.Background()
	p, err := s.Create(ctx, a, "Assigned", DefaultSettings())
	require.NoError(t, err)
	var groupID uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO device_groups (name) VALUES ('Root') RETURNING id`).Scan(&groupID))
	require.NoError(t, s.SetGroupPolicy(ctx, a, groupID, &p.ID))
	require.Equal(t, 1, auditCount(t, s, "group.policy_changed"))
	var details string
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT details::text FROM audit_events WHERE action = 'group.policy_changed'`).Scan(&details))
	require.JSONEq(t, `{"policy_id":"`+p.ID.String()+`"}`, details)
	require.ErrorIs(t, s.SetGroupPolicy(ctx, a, uuid.New(), &p.ID), ErrNotFound)
	require.ErrorIs(t, s.SetGroupPolicy(ctx, a, groupID, ptr(uuid.New())), ErrNotFound)
}

func ptr[T any](v T) *T { return &v }

func TestDeviceStatusConnect(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	approved := windowDevice(t, s, devices.StateApproved)
	pending := windowDevice(t, s, devices.StatePending)
	status := func(id uuid.UUID, want string) {
		t.Helper()
		got, err := s.DeviceStatus(ctx, id)
		require.NoError(t, err)
		require.Equal(t, want, got.Connect)
		blocked, err := s.CanConnect(ctx, db.New(s.Pool), id)
		require.NoError(t, err)
		require.Equal(t, want == "locked", blocked)
	}
	status(approved, "unrestricted") // push off
	status(pending, "unrestricted")
	require.NoError(t, s.SetPushEnabled(ctx, actor, true))
	status(approved, "unrestricted") // default policy is always reachable
	list, err := s.List(ctx)
	require.NoError(t, err)
	settings := DefaultSettings()
	settings["approve-mode"] = "password"
	settings["verification-method"] = "use-temporary-password"
	_, err = s.Update(ctx, actor, list[0].ID, nil, &settings)
	require.NoError(t, err)
	status(pending, "unrestricted")
	status(approved, "locked")
	window, err := s.OpenWindow(ctx, actor, approved, ptr(60), false)
	require.NoError(t, err)
	status(approved, "window")
	now = *window.EndsAt
	status(approved, "locked") // expiry is exclusive, even before the sweep
	now = now.Add(-time.Minute)
	require.NoError(t, s.CloseWindow(ctx, actor, approved, false))
	closed, err := s.DeviceStatus(ctx, approved)
	require.NoError(t, err)
	require.NotNil(t, closed.CloseUnconfirmedSince)
	require.Equal(t, "locked", closed.Connect)
	settings["approve-mode"] = "click"
	_, err = s.Update(ctx, actor, list[0].ID, nil, &settings)
	require.NoError(t, err)
	status(approved, "attended")
	settings["approve-mode"] = "password-click"
	_, err = s.Update(ctx, actor, list[0].ID, nil, &settings)
	require.NoError(t, err)
	status(approved, "attended")
}

func TestStrategyByDeviceIDMatchesExistingStrategy(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	deviceID := windowDevice(t, s, devices.StateApproved)
	var serverID uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT server_id FROM devices WHERE id=$1`, deviceID).Scan(&serverID))
	var parentID, groupID uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO device_groups (name,id_allow_list) VALUES ('strategy-parent',ARRAY['Dupe']) RETURNING id`).Scan(&parentID))
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO device_groups (name,parent_id,id_allow_list) VALUES ('strategy-group',$1,ARRAY['dUPE']) RETURNING id`, parentID).Scan(&groupID))
	_, err := s.Pool.Exec(ctx, `UPDATE devices SET group_id=$1,id_allow_list=ARRAY['111','222'] WHERE id=$2`, groupID, deviceID)
	require.NoError(t, err)
	_, err = s.Pool.Exec(ctx, `UPDATE global_id_allow_list SET ids=ARRAY['999'] WHERE id=true`)
	require.NoError(t, err)
	require.NoError(t, s.SetPushEnabled(ctx, actor, true))
	want, wantVersion, err := s.Strategy(ctx, serverID, "window-device", "u", 0)
	require.NoError(t, err)
	got, gotVersion, err := s.StrategyForDevice(ctx, deviceID, "u", 0)
	require.NoError(t, err)
	require.Equal(t, want, got)
	require.Equal(t, wantVersion, gotVersion)
}

func windowDevice(t *testing.T, s *Service, state string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var server, device uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO servers (name, id_host) VALUES ('window-server', 'window-host') RETURNING id`).Scan(&server))
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, 'window-device', 'u', $2) RETURNING id`, server, state).Scan(&device))
	return device
}

func TestAccessWindowLifecycle(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	approved := windowDevice(t, s, "approved")
	_, err := s.OpenWindow(ctx, actor, uuid.New(), ptr(60), false)
	require.ErrorIs(t, err, ErrNotFound)
	_, err = s.OpenWindow(ctx, actor, approved, ptr(30), false)
	var validation *ValidationError
	require.ErrorAs(t, err, &validation)
	require.Equal(t, "duration_minutes", validation.Field)
	_, err = s.OpenWindow(ctx, actor, approved, ptr(60), false)
	require.ErrorIs(t, err, ErrPushOff)
	require.NoError(t, s.SetPushEnabled(ctx, actor, true))
	_, err = s.Pool.Exec(ctx, `UPDATE devices SET state = 'pending' WHERE id = $1`, approved)
	require.NoError(t, err)
	_, err = s.OpenWindow(ctx, actor, approved, ptr(60), false)
	require.ErrorIs(t, err, ErrNotApproved)
	_, err = s.Pool.Exec(ctx, `UPDATE devices SET state = 'approved' WHERE id = $1`, approved)
	require.NoError(t, err)
	_, err = s.OpenWindow(ctx, actor, approved, ptr(60), false)
	require.ErrorIs(t, err, ErrAlwaysReachable)
	policy, err := s.List(ctx)
	require.NoError(t, err)
	settings := DefaultSettings()
	settings["approve-mode"] = "click"
	_, err = s.Update(ctx, actor, policy[0].ID, nil, &settings)
	require.NoError(t, err)
	w, err := s.OpenWindow(ctx, actor, approved, ptr(60), false)
	require.NoError(t, err)
	require.Equal(t, now.Add(time.Hour), *w.EndsAt)
	require.Equal(t, 1, auditCount(t, s, "access_window.opened"))
	_, err = s.OpenWindow(ctx, actor, approved, nil, false)
	require.ErrorIs(t, err, ErrWindowOpen)
	status, err := s.DeviceStatus(ctx, approved)
	require.NoError(t, err)
	require.Equal(t, "pending", status.State)
	require.NotNil(t, status.Window)
	require.NoError(t, s.CloseWindow(ctx, actor, approved, false))
	require.Equal(t, 1, auditCount(t, s, "access_window.closed"))
	require.ErrorIs(t, s.CloseWindow(ctx, actor, approved, false), ErrNotFound)
	status, err = s.DeviceStatus(ctx, approved)
	require.NoError(t, err)
	require.Equal(t, &now, status.CloseUnconfirmedSince)
}

func setupWindowPolicy(t *testing.T, s *Service, actor devices.Actor) {
	t.Helper()
	ctx := context.Background()
	policies, err := s.List(ctx)
	require.NoError(t, err)
	settings := DefaultSettings()
	settings["approve-mode"] = "click"
	_, err = s.Update(ctx, actor, policies[0].ID, nil, &settings)
	require.NoError(t, err)
	require.NoError(t, s.SetPushEnabled(ctx, actor, true))
}

func TestCloseWindowDisconnectAudit(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	device := windowDevice(t, s, "approved")
	setupWindowPolicy(t, s, actor)
	window, err := s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	for i := 1; i <= 3; i++ {
		_, err := s.Pool.Exec(ctx, `INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at, ended_at, disconnect_requested_at)
		VALUES ($1,$2,$3,$3,$4,$5)`, device, i, now, func() *time.Time {
			if i == 3 {
				return &now
			}
			return nil
		}(), func() *time.Time {
			if i == 2 {
				return &now
			}
			return nil
		}())
		require.NoError(t, err)
	}
	require.NoError(t, s.CloseWindow(ctx, actor, device, true))
	var count int
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM remote_sessions WHERE device_id=$1 AND disconnect_requested_by=$2`, device, actor.UserID).Scan(&count))
	require.Equal(t, 1, count)
	var details string
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT details::text FROM audit_events WHERE action='access_window.closed'`).Scan(&details))
	require.JSONEq(t, `{"window_id":"`+window.ID.String()+`","reason":"manual","disconnect":true,"sessions":1}`, details)
	_, err = s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	require.NoError(t, s.CloseWindow(ctx, actor, device, false))
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM remote_sessions WHERE device_id=$1 AND disconnect_requested_by=$2`, device, actor.UserID).Scan(&count))
	require.Equal(t, 1, count)
}

func TestSweepExpiredWindowAndUnconfirmedAlert(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	device := windowDevice(t, s, "approved")
	setupWindowPolicy(t, s, actor)
	w, err := s.OpenWindow(ctx, actor, device, ptr(60), true)
	require.NoError(t, err)
	_, err = s.Pool.Exec(ctx, `INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at) VALUES ($1,1,$2,$2)`, device, now)
	require.NoError(t, err)
	now = now.Add(time.Hour - time.Second)
	require.NoError(t, s.SweepExpired(ctx))
	status, err := s.DeviceStatus(ctx, device)
	require.NoError(t, err)
	require.NotNil(t, status.Window)
	now = now.Add(time.Second)
	require.NoError(t, s.SweepExpired(ctx))
	status, err = s.DeviceStatus(ctx, device)
	require.NoError(t, err)
	require.Nil(t, status.Window)
	require.Equal(t, w.EndsAt, status.CloseUnconfirmedSince)
	var closedAt time.Time
	var by *uuid.UUID
	var details string
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT w.closed_at, e.actor_user_id, e.details::text FROM access_windows w JOIN audit_events e ON e.target_id=w.device_id::text AND e.action='access_window.closed' WHERE w.id=$1`, w.ID).Scan(&closedAt, &by, &details))
	require.Equal(t, *w.EndsAt, closedAt)
	require.Nil(t, by)
	require.JSONEq(t, `{"window_id":"`+w.ID.String()+`","reason":"expired","disconnect":true,"sessions":1}`, details)
	var count int
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM remote_sessions WHERE device_id=$1 AND disconnect_requested_at IS NOT NULL AND disconnect_requested_by IS NULL`, device).Scan(&count))
	require.Equal(t, 1, count)
	now = now.Add(5*time.Minute - time.Second)
	require.NoError(t, s.SweepExpired(ctx))
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND kind='access_window_unconfirmed'`, device).Scan(&count))
	require.Zero(t, count)
	now = now.Add(time.Second)
	require.NoError(t, s.SweepExpired(ctx))
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND kind='access_window_unconfirmed' AND resolved_at IS NULL`, device).Scan(&count))
	require.Equal(t, 1, count)
	resolved, err := s.ResolveDevice(ctx, device)
	require.NoError(t, err)
	_, err = s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	windowVersion := versionWithEmptyIDAllowList(resolved.Policy.Settings, &Window{}, now)
	var server uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT server_id FROM devices WHERE id=$1`, device).Scan(&server))
	_, _, err = s.Strategy(ctx, server, "window-device", "u", windowVersion)
	require.NoError(t, err)
	require.NoError(t, s.SweepExpired(ctx))
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND kind='access_window_unconfirmed' AND resolved_at IS NULL`, device).Scan(&count))
	require.Equal(t, 1, count, "a new window version does not confirm the prior close")
	require.NoError(t, s.CloseWindow(ctx, actor, device, false))
	version := versionWithEmptyIDAllowList(resolved.Policy.Settings, nil, now)
	_, _, err = s.Strategy(ctx, server, "window-device", "u", version)
	require.NoError(t, err)
	require.NoError(t, s.SweepExpired(ctx))
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND kind='access_window_unconfirmed' AND resolved_at IS NULL`, device).Scan(&count))
	require.Zero(t, count)
	status, err = s.DeviceStatus(ctx, device)
	require.NoError(t, err)
	require.Equal(t, "applied", status.State)
	require.Nil(t, status.CloseUnconfirmedSince)
	_, err = s.Pool.Exec(ctx, `UPDATE devices SET strategy_version_seen=NULL WHERE id=$1`, device)
	require.NoError(t, err)
	require.NoError(t, s.SweepExpired(ctx))
	require.NoError(t, s.SetPushEnabled(ctx, actor, false))
	require.NoError(t, s.SweepExpired(ctx))
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND kind='access_window_unconfirmed' AND resolved_at IS NULL`, device).Scan(&count))
	require.Zero(t, count)
	status, err = s.DeviceStatus(ctx, device)
	require.NoError(t, err)
	require.Equal(t, "off", status.State)
}

func TestAlertSurvivesPushOff(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	device := windowDevice(t, s, "approved")
	setupWindowPolicy(t, s, actor)
	_, err := s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	require.NoError(t, s.CloseWindow(ctx, actor, device, false))
	_, err = s.Pool.Exec(ctx, `UPDATE devices SET strategy_version_seen=$1 WHERE id=$2`, int64(0), device)
	require.NoError(t, err)
	now = now.Add(5 * time.Minute)
	require.NoError(t, s.SweepExpired(ctx))
	var alertID uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT id FROM device_alerts WHERE device_id=$1 AND kind='access_window_unconfirmed' AND resolved_at IS NULL`, device).Scan(&alertID))
	require.NoError(t, s.SetPushEnabled(ctx, actor, false))
	require.NoError(t, s.SweepExpired(ctx))
	var resolvedAt *time.Time
	var resolvedBy *uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT resolved_at, resolved_by FROM device_alerts WHERE id=$1`, alertID).Scan(&resolvedAt, &resolvedBy))
	require.Nil(t, resolvedAt)
	require.Nil(t, resolvedBy)
	status, err := s.DeviceStatus(ctx, device)
	require.NoError(t, err)
	require.Equal(t, "off", status.State)
	require.NotNil(t, status.CloseUnconfirmedSince)
}

func TestNoFalseAlertAfterPolicyEdit(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	device := windowDevice(t, s, "approved")
	setupWindowPolicy(t, s, actor)
	w, err := s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	require.NoError(t, s.CloseWindow(ctx, actor, device, false))
	resolved, err := s.ResolveDevice(ctx, device)
	require.NoError(t, err)
	baseline := versionWithEmptyIDAllowList(resolved.Policy.Settings, nil, now)
	var server uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT server_id FROM devices WHERE id=$1`, device).Scan(&server))
	_, _, err = s.Strategy(ctx, server, "window-device", "u", baseline)
	require.NoError(t, err)
	var confirmed *time.Time
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT close_confirmed_at FROM access_windows WHERE id=$1`, w.ID).Scan(&confirmed))
	require.NotNil(t, confirmed)
	settings := resolved.Policy.Settings
	settings["enable-file-transfer"] = "N"
	_, err = s.Update(ctx, actor, resolved.Policy.ID, nil, &settings)
	require.NoError(t, err)
	now = now.Add(10 * time.Minute)
	require.NoError(t, s.SweepExpired(ctx))
	var count int
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_alerts WHERE kind='access_window_unconfirmed' AND device_id=$1`, device).Scan(&count))
	require.Zero(t, count)
	status, err := s.DeviceStatus(ctx, device)
	require.NoError(t, err)
	require.Nil(t, status.CloseUnconfirmedSince)
}

func TestStrategyConfirmsClose(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	device := windowDevice(t, s, "approved")
	setupWindowPolicy(t, s, actor)
	resolved, err := s.ResolveDevice(ctx, device)
	require.NoError(t, err)
	baseline := versionWithEmptyIDAllowList(resolved.Policy.Settings, nil, now)
	windowVersion := versionWithEmptyIDAllowList(resolved.Policy.Settings, &Window{}, now)
	var server uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT server_id FROM devices WHERE id=$1`, device).Scan(&server))

	first, err := s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	require.NoError(t, s.CloseWindow(ctx, actor, device, false))
	now = now.Add(5 * time.Minute)
	require.NoError(t, s.SweepExpired(ctx))
	_, _, err = s.Strategy(ctx, server, "window-device", "u", baseline)
	require.NoError(t, err)
	var confirmed *time.Time
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT close_confirmed_at FROM access_windows WHERE id=$1`, first.ID).Scan(&confirmed))
	require.Equal(t, &now, confirmed)
	require.NoError(t, s.SweepExpired(ctx))
	var openAlerts int
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND kind='access_window_unconfirmed' AND resolved_at IS NULL`, device).Scan(&openAlerts))
	require.Zero(t, openAlerts)

	second, err := s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	require.NoError(t, s.CloseWindow(ctx, actor, device, false))
	_, err = s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	_, _, err = s.Strategy(ctx, server, "window-device", "u", windowVersion)
	require.NoError(t, err)
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT close_confirmed_at FROM access_windows WHERE id=$1`, second.ID).Scan(&confirmed))
	require.Nil(t, confirmed)
	require.NoError(t, s.CloseWindow(ctx, actor, device, false))
	_, _, err = s.Strategy(ctx, server, "window-device", "u", baseline)
	require.NoError(t, err)
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT close_confirmed_at FROM access_windows WHERE id=$1`, second.ID).Scan(&confirmed))
	require.Equal(t, &now, confirmed)

	expiring, err := s.OpenWindow(ctx, actor, device, ptr(60), false)
	require.NoError(t, err)
	now = now.Add(time.Hour)
	_, _, err = s.Strategy(ctx, server, "window-device", "u", baseline)
	require.NoError(t, err)
	require.NoError(t, s.SweepExpired(ctx))
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT close_confirmed_at FROM access_windows WHERE id=$1`, expiring.ID).Scan(&confirmed))
	require.Nil(t, confirmed)
	_, _, err = s.Strategy(ctx, server, "window-device", "u", baseline)
	require.NoError(t, err)
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT close_confirmed_at FROM access_windows WHERE id=$1`, expiring.ID).Scan(&confirmed))
	require.Equal(t, &now, confirmed)
}

func TestSweepContinuesAfterCandidateError(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	first := windowDevice(t, s, "approved")
	var server, second uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT server_id FROM devices WHERE id=$1`, first).Scan(&server))
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, 'second-window', 'u', 'approved') RETURNING id`, server).Scan(&second))
	setupWindowPolicy(t, s, actor)
	failed, err := s.OpenWindow(ctx, actor, first, ptr(60), false)
	require.NoError(t, err)
	now = now.Add(time.Minute)
	good, err := s.OpenWindow(ctx, actor, second, ptr(60), false)
	require.NoError(t, err)
	_, err = s.Pool.Exec(ctx, `CREATE TABLE test_failing_windows (id uuid PRIMARY KEY)`)
	require.NoError(t, err)
	_, err = s.Pool.Exec(ctx, `INSERT INTO test_failing_windows (id) VALUES ($1)`, failed.ID)
	require.NoError(t, err)
	_, err = s.Pool.Exec(ctx, `CREATE FUNCTION fail_one_window_close() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM test_failing_windows WHERE id=NEW.id) THEN RAISE EXCEPTION 'forced close failure'; END IF; RETURN NEW; END $$`)
	require.NoError(t, err)
	_, err = s.Pool.Exec(ctx, `CREATE TRIGGER fail_one_window_close BEFORE UPDATE OF closed_at ON access_windows FOR EACH ROW EXECUTE FUNCTION fail_one_window_close()`)
	require.NoError(t, err)
	now = now.Add(61 * time.Minute)
	err = s.SweepExpired(ctx)
	require.ErrorContains(t, err, "forced close failure")
	var closed *time.Time
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT closed_at FROM access_windows WHERE id=$1`, good.ID).Scan(&closed))
	require.Equal(t, good.EndsAt, closed)
}

func TestUnconfirmedCloseAlertOncePerWindow(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	device := windowDevice(t, s, "approved")
	setupWindowPolicy(t, s, actor)
	first, err := s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	require.NoError(t, s.CloseWindow(ctx, actor, device, false))
	now = now.Add(5 * time.Minute)
	require.NoError(t, s.SweepExpired(ctx))
	var alert uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT id FROM device_alerts WHERE device_id=$1 AND details->>'window_id'=$2`, device, first.ID.String()).Scan(&alert))
	_, err = s.Pool.Exec(ctx, `UPDATE device_alerts SET resolved_at=$1, resolved_by=$2 WHERE id=$3`, now, actor.UserID, alert)
	require.NoError(t, err)
	require.NoError(t, s.SweepExpired(ctx))
	var count int
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND kind='access_window_unconfirmed'`, device).Scan(&count))
	require.Equal(t, 1, count)
	second, err := s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	require.NoError(t, s.CloseWindow(ctx, actor, device, false))
	now = now.Add(5 * time.Minute)
	require.NoError(t, s.SweepExpired(ctx))
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND kind='access_window_unconfirmed'`, device).Scan(&count))
	require.Equal(t, 2, count)
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT id FROM device_alerts WHERE device_id=$1 AND details->>'window_id'=$2 AND resolved_at IS NULL`, device, second.ID.String()).Scan(&alert))
}

func TestStaleUnconfirmedCandidateCannotOpenAlert(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	device := windowDevice(t, s, "approved")
	setupWindowPolicy(t, s, actor)
	w, err := s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	require.NoError(t, s.CloseWindow(ctx, actor, device, false))
	resolved, err := s.ResolveDevice(ctx, device)
	require.NoError(t, err)
	var server uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT server_id FROM devices WHERE id=$1`, device).Scan(&server))
	baseline := versionWithEmptyIDAllowList(resolved.Policy.Settings, nil, now)
	_, _, err = s.Strategy(ctx, server, "window-device", "u", baseline)
	require.NoError(t, err)
	details, err := json.Marshal(map[string]any{"window_id": w.ID, "closed_at": now})
	require.NoError(t, err)
	now = now.Add(5 * time.Minute)
	require.NoError(t, db.New(s.Pool).OpenAccessWindowAlert(ctx, db.OpenAccessWindowAlertParams{DeviceID: device, WindowID: w.ID, Now: now, Details: details}))
	var count int
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND kind='access_window_unconfirmed'`, device).Scan(&count))
	require.Zero(t, count)
}

func TestPushOffBlockedWhileWindowOpen(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	device := windowDevice(t, s, "approved")
	setupWindowPolicy(t, s, actor)
	_, err := s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	require.ErrorIs(t, s.SetPushEnabled(ctx, actor, false), ErrWindowOpen)
	enabled, _, _, err := s.PushEnabled(ctx)
	require.NoError(t, err)
	require.True(t, enabled)
	require.NoError(t, s.CloseWindow(ctx, actor, device, false))
	require.NoError(t, s.SetPushEnabled(ctx, actor, false))
}

func TestDeviceStatusOpenWindowAfterClockStep(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	device := windowDevice(t, s, "approved")
	setupWindowPolicy(t, s, actor)
	closed, err := s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	require.NoError(t, s.CloseWindow(ctx, actor, device, false))
	now = now.Add(-time.Hour)
	opened, err := s.OpenWindow(ctx, actor, device, nil, false)
	require.NoError(t, err)
	status, err := s.DeviceStatus(ctx, device)
	require.NoError(t, err)
	require.NotNil(t, status.Window)
	require.Equal(t, opened.ID, status.Window.ID)
	require.NotEqual(t, closed.ID, status.Window.ID)
}

func TestSweepWithoutDisconnectEvenWhenPushOff(t *testing.T) {
	s, actor := policyTest(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	device := windowDevice(t, s, "approved")
	setupWindowPolicy(t, s, actor)
	_, err := s.OpenWindow(ctx, actor, device, ptr(60), false)
	require.NoError(t, err)
	_, err = s.Pool.Exec(ctx, `INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at) VALUES ($1,1,$2,$2)`, device, now)
	require.NoError(t, err)
	now = now.Add(65 * time.Minute)
	require.NoError(t, s.SweepExpired(ctx))
	require.NoError(t, s.SetPushEnabled(ctx, actor, false))
	var count int
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM remote_sessions WHERE device_id=$1 AND disconnect_requested_at IS NOT NULL`, device).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM device_alerts WHERE device_id=$1 AND kind='access_window_unconfirmed'`, device).Scan(&count))
	require.Equal(t, 1, count)
}

func TestResolveDevicePolicyChain(t *testing.T) {
	s, a := policyTest(t)
	ctx := context.Background()
	var root, child, grandchild, device, groupless, server uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO device_groups (name) VALUES ('Root') RETURNING id`).Scan(&root))
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO device_groups (name, parent_id) VALUES ('Child', $1) RETURNING id`, root).Scan(&child))
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO device_groups (name, parent_id) VALUES ('Grandchild', $1) RETURNING id`, child).Scan(&grandchild))
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO servers (name, id_host) VALUES ('s', 'h') RETURNING id`).Scan(&server))
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, group_id) VALUES ($1, '1', 'u1', $2) RETURNING id`, server, grandchild).Scan(&device))
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid) VALUES ($1, '2', 'u2') RETURNING id`, server).Scan(&groupless))
	check := func(source string, group *uuid.UUID) {
		t.Helper()
		r, err := s.ResolveDevice(ctx, device)
		require.NoError(t, err)
		require.Equal(t, source, r.Source)
		require.Equal(t, group, r.SourceGroupID)
	}
	check("default", nil)
	p, err := s.Create(ctx, a, "Assigned", DefaultSettings())
	require.NoError(t, err)
	for _, step := range []struct {
		group  uuid.UUID
		source string
	}{{root, "parent_group"}, {child, "parent_group"}, {grandchild, "group"}} {
		require.NoError(t, s.SetGroupPolicy(ctx, a, step.group, &p.ID))
		check(step.source, &step.group)
	}
	require.NoError(t, s.SetGroupPolicy(ctx, a, grandchild, nil))
	check("parent_group", &child)
	r, err := s.ResolveDevice(ctx, groupless)
	require.NoError(t, err)
	require.Equal(t, "default", r.Source)
	_, err = s.ResolveDevice(ctx, uuid.New())
	require.True(t, errors.Is(err, ErrNotFound))
}

func TestResolveGroup(t *testing.T) {
	s, a := policyTest(t)
	ctx := context.Background()
	var root, child, grandchild uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO device_groups (name) VALUES ('Root') RETURNING id`).Scan(&root))
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO device_groups (name, parent_id) VALUES ('Child', $1) RETURNING id`, root).Scan(&child))
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO device_groups (name, parent_id) VALUES ('Grandchild', $1) RETURNING id`, child).Scan(&grandchild))
	r, err := s.ResolveGroup(ctx, grandchild)
	require.NoError(t, err)
	require.Equal(t, "default", r.Source)
	p, err := s.Create(ctx, a, "Assigned", DefaultSettings())
	require.NoError(t, err)
	require.NoError(t, s.SetGroupPolicy(ctx, a, root, &p.ID))
	r, err = s.ResolveGroup(ctx, grandchild)
	require.NoError(t, err)
	require.Equal(t, "parent_group", r.Source)
	require.Equal(t, &root, r.SourceGroupID)
	require.Equal(t, "Root", r.SourceGroupName)
	require.NoError(t, s.SetGroupPolicy(ctx, a, child, &p.ID))
	r, err = s.ResolveGroup(ctx, grandchild)
	require.NoError(t, err)
	require.Equal(t, "parent_group", r.Source)
	require.Equal(t, &child, r.SourceGroupID)
	require.NoError(t, s.SetGroupPolicy(ctx, a, grandchild, &p.ID))
	r, err = s.ResolveGroup(ctx, grandchild)
	require.NoError(t, err)
	require.Equal(t, "group", r.Source)
	require.Equal(t, &grandchild, r.SourceGroupID)
	require.NoError(t, s.SetGroupPolicy(ctx, a, grandchild, nil))
	r, err = s.ResolveGroup(ctx, grandchild)
	require.NoError(t, err)
	require.Equal(t, &child, r.SourceGroupID)
	_, err = s.ResolveGroup(ctx, uuid.New())
	require.ErrorIs(t, err, ErrNotFound)
}
