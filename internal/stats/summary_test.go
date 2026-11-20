package stats_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/stats"
	"github.com/dottio123/ferricade/internal/store/db"
)

var summaryNow = time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)

func TestSummaryGroupConflictAttention(t *testing.T) {
	e := newEnv(t)
	a, b := e.group(t, "Helpdesk"), e.group(t, "Finance-Payroll")
	deleted := e.group(t, "Deleted")
	id := e.addDevice(t, devSpec{rid: "conflict", state: "approved", group: &a})
	ctx := context.Background()
	_, err := e.pool.Exec(ctx, `INSERT INTO device_alerts(device_id,kind,created_at,details) VALUES($1,'group_conflict',$2,jsonb_build_object('group_ids',jsonb_build_array($3::text,$4::text,$5::text)))`, id, summaryNow, a, b, deleted)
	require.NoError(t, err)
	_, err = e.pool.Exec(ctx, `DELETE FROM device_groups WHERE id=$1`, deleted)
	require.NoError(t, err)
	got, err := stats.Summary(ctx, e.pool, nil, summaryNow)
	require.NoError(t, err)
	require.Equal(t, 1, got.OpenAlerts)
	require.Equal(t, []stats.Attention{{Kind: "group_conflict", DeviceID: id, RustdeskID: "conflict", Name: "conflict", Since: summaryNow, Detail: "Finance-Payroll, Helpdesk"}}, got.Attention)
	var user uuid.UUID
	require.NoError(t, e.pool.QueryRow(ctx, `INSERT INTO users(username,role,password_hash) VALUES('viewer','user','unused') RETURNING id`).Scan(&user))
	scoped, err := stats.Summary(ctx, e.pool, nil, summaryNow, &user)
	require.NoError(t, err)
	require.Empty(t, scoped.Attention)
	_, err = e.pool.Exec(ctx, `INSERT INTO user_grants(user_id,group_id) VALUES($1,$2)`, user, a)
	require.NoError(t, err)
	scoped, err = stats.Summary(ctx, e.pool, nil, summaryNow, &user)
	require.NoError(t, err)
	require.Len(t, scoped.Attention, 1)
	require.Equal(t, "Helpdesk", scoped.Attention[0].Detail)
	_, err = e.pool.Exec(ctx, `UPDATE device_alerts SET resolved_at=now() WHERE device_id=$1`, id)
	require.NoError(t, err)
	got, err = stats.Summary(ctx, e.pool, nil, summaryNow)
	require.NoError(t, err)
	require.Empty(t, got.Attention)
}

type devSpec struct {
	rid, state, os, version, alias, hostname string
	group                                    *uuid.UUID
	first, last                              time.Time
}

func (e *env) addDevice(t *testing.T, s devSpec) uuid.UUID {
	t.Helper()
	if s.first.IsZero() {
		s.first = summaryNow.Add(-time.Minute)
	}
	if s.last.IsZero() {
		s.last = summaryNow.Add(-time.Minute)
	}
	var id uuid.UUID
	require.NoError(t, e.pool.QueryRow(context.Background(),
		`INSERT INTO devices (server_id, rustdesk_id, uuid, state, os, client_version, alias, hostname, group_id, first_seen_at, last_seen_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
		e.serverID, s.rid, "u-"+s.rid, s.state, s.os, s.version, s.alias, s.hostname, s.group, s.first, s.last).Scan(&id))
	return id
}

func (e *env) group(t *testing.T, name string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, e.pool.QueryRow(context.Background(),
		`INSERT INTO device_groups (name) VALUES ($1) RETURNING id`, name).Scan(&id))
	return id
}

func (e *env) alert(t *testing.T, device uuid.UUID, at time.Time, resolved bool) {
	t.Helper()
	var res *time.Time
	if resolved {
		res = &at
	}
	_, err := e.pool.Exec(context.Background(),
		`INSERT INTO device_alerts (device_id, kind, created_at, resolved_at) VALUES ($1, 'uuid_mismatch', $2, $3)`, device, at, res)
	require.NoError(t, err)
}

func onlineSet(ids ...string) func(string) bool {
	return func(id string) bool {
		for _, i := range ids {
			if i == id {
				return true
			}
		}
		return false
	}
}

func TestSummaryAccessWindowUnconfirmedAttention(t *testing.T) {
	e := newEnv(t)
	device := e.addDevice(t, devSpec{rid: "window-summary", state: "approved"})
	e.alert(t, device, summaryNow.Add(-time.Hour), false)
	_, err := e.pool.Exec(context.Background(), `INSERT INTO device_alerts(device_id,kind,details,created_at) VALUES($1,'access_window_unconfirmed','{}',$2)`, device, summaryNow.Add(-30*time.Minute))
	require.NoError(t, err)
	e.addDevice(t, devSpec{rid: "pending-summary", state: "pending", first: summaryNow.Add(-48 * time.Hour)})
	got, err := stats.Summary(context.Background(), e.pool, nil, summaryNow)
	require.NoError(t, err)
	require.Equal(t, 2, got.OpenAlerts)
	require.Len(t, got.Attention, 3)
	require.Equal(t, stats.KindUUIDMismatch, got.Attention[0].Kind)
	require.Equal(t, stats.KindAccessWindowUnconfirmed, got.Attention[1].Kind)
	require.Equal(t, stats.KindPendingLong, got.Attention[2].Kind)
	require.Equal(t, summaryNow.Add(-30*time.Minute), got.Attention[1].Since)
}

func TestSummaryCounts(t *testing.T) {
	e := newEnv(t)
	hq := e.group(t, "HQ")
	lab := e.group(t, "Admin lab")
	e.group(t, "Empty")
	e.addDevice(t, devSpec{rid: "1", state: "approved", os: "windows / Windows 11", version: "1.5.0", group: &hq})
	e.addDevice(t, devSpec{rid: "2", state: "approved", os: "linux / Debian", version: "1.5.0", group: &hq})
	e.addDevice(t, devSpec{rid: "3", state: "approved", os: "macos / 14", version: "1.4.0", group: &lab})
	e.addDevice(t, devSpec{rid: "4", state: "approved", os: "", version: ""})
	e.addDevice(t, devSpec{rid: "5", state: "pending", os: "windows / x", version: "1.0.0", group: &hq})
	e.addDevice(t, devSpec{rid: "6", state: "rejected"})
	e.addDevice(t, devSpec{rid: "7", state: "archived"})
	d1 := e.addDevice(t, devSpec{rid: "8", state: "approved", os: "windows / Windows 10", version: "1.5.0"})
	e.openSession(t, d1, 1, summaryNow.Add(-time.Hour))
	e.openUnauthedSession(t, d1, 2, summaryNow.Add(-time.Hour)) // not counted
	e.alert(t, d1, summaryNow.Add(-time.Hour), false)
	e.alert(t, e.addDevice(t, devSpec{rid: "9", state: "approved", os: "windows / z", version: "1.5.0"}), summaryNow.Add(-time.Hour), true)

	// Device 5 is pending: online does not count it. 1 and 3 are approved and online.
	got, err := stats.Summary(context.Background(), e.pool, onlineSet("1", "3", "5"), summaryNow)
	require.NoError(t, err)

	require.Equal(t, summaryNow, got.GeneratedAt)
	require.Equal(t, stats.DeviceCounts{Approved: 6, Pending: 1, Rejected: 1, Archived: 1, Online: 2}, got.Devices)
	require.Equal(t, 1, got.ActiveSessions)
	require.Equal(t, 1, got.OpenAlerts)
	require.Equal(t, []stats.OSCount{{"Windows", 3}, {"Linux", 1}, {"macOS", 1}, {"Other", 1}}, got.OS)
	require.Equal(t, []stats.VersionCount{
		{"1.5.0", 4, false}, {"1.4.0", 1, false}, {"unknown", 1, false},
	}, got.Versions)
	require.Len(t, got.Groups, 4)
	require.Equal(t, stats.GroupCount{ID: &lab, Name: "Admin lab", Online: 1, Total: 1}, got.Groups[0])
	require.Equal(t, "Empty", got.Groups[1].Name)
	require.NotNil(t, got.Groups[1].ID)
	require.Equal(t, 0, got.Groups[1].Total)
	require.Equal(t, stats.GroupCount{ID: &hq, Name: "HQ", Online: 1, Total: 2}, got.Groups[2])
	require.Equal(t, stats.GroupCount{Name: "Ungrouped", Online: 0, Total: 3}, got.Groups[3])
}

func TestSummaryEmpty(t *testing.T) {
	e := newEnv(t)
	g := e.group(t, "Only")
	e.addDevice(t, devSpec{rid: "1", state: "approved", group: &g})
	got, err := stats.Summary(context.Background(), e.pool, onlineSet(), summaryNow)
	require.NoError(t, err)
	require.Len(t, got.Groups, 1, "Ungrouped is left out when empty")
	require.Equal(t, "Only", got.Groups[0].Name)

	e2 := newEnv(t)
	got, err = stats.Summary(context.Background(), e2.pool, onlineSet(), summaryNow)
	require.NoError(t, err)
	require.NotNil(t, got.OS)
	require.NotNil(t, got.Versions)
	require.NotNil(t, got.Groups)
	require.NotNil(t, got.Attention)
}

func TestSummaryOSMapping(t *testing.T) {
	e := newEnv(t)
	for i, os := range []string{
		"windows / Windows 11 Pro", "macos / 14", "android / 13", "linux / Linux 24.04",
		"ubuntu / Linux 24.04 Ubuntu 24.04 LTS", "debian / Linux 12", "fedora / Linux 42", "centos / Linux 9",
		"rhel / Linux 9", "rocky / Linux 9", "almalinux / Linux 9", "arch / Linux rolling",
		"manjaro / Linux rolling", "linuxmint / Linux 22", "opensuse / Linux Tumbleweed",
		"opensuse-leap / Linux 15", "opensuse-tumbleweed / Linux rolling", "sles / Linux 15",
		"pop / Linux 22.04", "elementary / Linux 8", "kali / Linux rolling", "raspbian / Linux 12",
		"alpine / Linux 3.21", "nixos / Linux 25", "gentoo / Linux rolling", "zorin / Linux 17",
		"endeavouros / Linux rolling", "deepin / Linux 23", "kylin / Linux 10", "uos / Linux 20",
		"freebsd / 14.1", "foobar / Example OS", "unknown", "",
	} {
		e.addDevice(t, devSpec{rid: fmt.Sprint(i), state: "approved", os: os})
	}
	// A second Ubuntu makes count order differ from the name order.
	e.addDevice(t, devSpec{rid: "ubuntu-2", state: "approved", os: "Ubuntu / Linux 24.04"})
	got, err := stats.Summary(context.Background(), e.pool, onlineSet(), summaryNow)
	require.NoError(t, err)
	require.Equal(t, []stats.OSCount{
		{"openSUSE", 3}, {"Ubuntu", 2}, {"AlmaLinux", 1}, {"Alpine Linux", 1}, {"Android", 1},
		{"Arch Linux", 1}, {"CentOS", 1}, {"Debian", 1}, {"deepin", 1}, {"elementary OS", 1},
		{"EndeavourOS", 1}, {"Fedora", 1}, {"Foobar", 1}, {"Freebsd", 1}, {"Gentoo", 1},
		{"Kali Linux", 1}, {"Kylin", 1}, {"Linux", 1}, {"Linux Mint", 1}, {"macOS", 1},
		{"Manjaro", 1}, {"NixOS", 1}, {"Pop!_OS", 1}, {"Raspberry Pi OS", 1}, {"RHEL", 1},
		{"Rocky Linux", 1}, {"SLES", 1}, {"UOS", 1}, {"Windows", 1}, {"Zorin OS", 1}, {"Other", 2},
	}, got.OS)
}

func TestSummaryAttention(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	q := db.New(e.pool)
	require.NoError(t, stats.SaveThresholds(ctx, q, stats.Thresholds{OfflineDays: 7, PendingHours: 24, MinClientVersion: "1.5.0"}))
	day := 24 * time.Hour

	mm := e.addDevice(t, devSpec{rid: "mm", state: "approved", version: "1.5.0", alias: "Front desk", hostname: "pc1"})
	e.alert(t, mm, summaryNow.Add(-time.Hour), false)

	e.addDevice(t, devSpec{rid: "pend-over", state: "pending", first: summaryNow.Add(-24*time.Hour - time.Second)})
	e.addDevice(t, devSpec{rid: "pend-under", state: "pending", first: summaryNow.Add(-24*time.Hour + time.Second)})

	e.addDevice(t, devSpec{rid: "off-over", state: "approved", version: "1.5.0", hostname: "box", last: summaryNow.Add(-7*day - time.Second)})
	e.addDevice(t, devSpec{rid: "off-under", state: "approved", version: "1.5.0", last: summaryNow.Add(-7*day + time.Second)})
	e.addDevice(t, devSpec{rid: "off-but-online", state: "approved", version: "1.5.0", last: summaryNow.Add(-30 * day)})
	e.addDevice(t, devSpec{rid: "off-archived", state: "archived", last: summaryNow.Add(-30 * day)})

	e.addDevice(t, devSpec{rid: "old", state: "approved", version: "1.4.9", first: summaryNow.Add(-2 * day)})
	e.addDevice(t, devSpec{rid: "ok-1.5", state: "approved", version: "1.5"})
	e.addDevice(t, devSpec{rid: "unknown-version", state: "approved", version: ""})
	e.addDevice(t, devSpec{rid: "old-pending", state: "pending", version: "1.0"})

	got, err := stats.Summary(ctx, e.pool, onlineSet("off-but-online", "old", "ok-1.5", "unknown-version", "mm"), summaryNow)
	require.NoError(t, err)
	var kinds, ids []string
	for _, a := range got.Attention {
		kinds = append(kinds, a.Kind)
		ids = append(ids, a.RustdeskID)
	}
	require.Equal(t, []string{"uuid_mismatch", "pending_long", "offline_long", "outdated_client"}, kinds)
	require.Equal(t, []string{"mm", "pend-over", "off-over", "old"}, ids)
	require.Equal(t, "Front desk", got.Attention[0].Name)
	require.Equal(t, summaryNow.Add(-time.Hour), got.Attention[0].Since)
	require.Equal(t, summaryNow.Add(-24*time.Hour-time.Second), got.Attention[1].Since)
	require.Equal(t, "box", got.Attention[2].Name)
	require.Equal(t, summaryNow.Add(-7*day-time.Second), got.Attention[2].Since)
	require.Equal(t, "old", got.Attention[3].Name, "falls back to the RustDesk ID")
	for _, a := range got.Attention {
		require.NotEqual(t, uuid.Nil, a.DeviceID)
		require.NotEmpty(t, a.Detail)
	}
	outdated := map[string]bool{}
	for _, v := range got.Versions {
		outdated[v.Version] = v.Outdated
	}
	require.True(t, outdated["1.4.9"])
	require.False(t, outdated["1.5"])
	require.False(t, outdated["unknown"])
}

func TestSummaryNoMinVersion(t *testing.T) {
	e := newEnv(t)
	e.addDevice(t, devSpec{rid: "old", state: "approved", version: "0.1"})
	got, err := stats.Summary(context.Background(), e.pool, onlineSet("old"), summaryNow)
	require.NoError(t, err)
	require.Empty(t, got.Attention)
	require.False(t, got.Versions[0].Outdated)
}

func TestSummaryAttentionOrderAndCap(t *testing.T) {
	e := newEnv(t)
	for i := range 55 {
		e.addDevice(t, devSpec{rid: fmt.Sprintf("p%02d", i), state: "pending", first: summaryNow.Add(-48*time.Hour - time.Duration(i)*time.Minute)})
	}
	e.alert(t, e.addDevice(t, devSpec{rid: "mm", state: "approved"}), summaryNow, false)
	got, err := stats.Summary(context.Background(), e.pool, onlineSet("mm"), summaryNow)
	require.NoError(t, err)
	require.Len(t, got.Attention, 50)
	require.Equal(t, "uuid_mismatch", got.Attention[0].Kind)
	require.Equal(t, "p54", got.Attention[1].RustdeskID, "oldest since first within a kind")
	require.Equal(t, "p06", got.Attention[49].RustdeskID)
}

func TestCompareVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"1.5.0", "1.4.9", 1}, {"1.4.9", "1.5.0", -1}, {"1.5", "1.5.0", 0}, {"1.5.0", "1.5", 0},
		{"1.10.0", "1.9.9", 1}, {"", "0", 0}, {"1.5.0.1", "1.5.0", 1}, {"1.x.0", "1.0.0", 0}, {"1.5.0-nightly", "1.5.0", 0},
	} {
		require.Equal(t, c.want, stats.CompareVersions(c.a, c.b), "%q vs %q", c.a, c.b)
	}
}

func TestThresholdsDefaultsAndRoundTrip(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	q := db.New(e.pool)
	got, err := stats.LoadThresholds(ctx, q)
	require.NoError(t, err)
	require.Equal(t, stats.Thresholds{OfflineDays: 7, PendingHours: 24, MinClientVersion: ""}, got)

	want := stats.Thresholds{OfflineDays: 30, PendingHours: 1, MinClientVersion: "1.5.0.1"}
	require.NoError(t, stats.SaveThresholds(ctx, q, want))
	got, err = stats.LoadThresholds(ctx, q)
	require.NoError(t, err)
	require.Equal(t, want, got)
}

func TestSaveThresholdsValidates(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	q := db.New(e.pool)
	for _, c := range []struct {
		t     stats.Thresholds
		field string
	}{
		{stats.Thresholds{OfflineDays: 0, PendingHours: 24}, "offline_days"},
		{stats.Thresholds{OfflineDays: 366, PendingHours: 24}, "offline_days"},
		{stats.Thresholds{OfflineDays: 7, PendingHours: 0}, "pending_hours"},
		{stats.Thresholds{OfflineDays: 7, PendingHours: 721}, "pending_hours"},
		{stats.Thresholds{OfflineDays: 7, PendingHours: 24, MinClientVersion: "v1.5"}, "min_client_version"},
		{stats.Thresholds{OfflineDays: 7, PendingHours: 24, MinClientVersion: "1.2.3.4.5"}, "min_client_version"},
		{stats.Thresholds{OfflineDays: 7, PendingHours: 24, MinClientVersion: "1."}, "min_client_version"},
	} {
		err := stats.SaveThresholds(ctx, q, c.t)
		var ve *stats.ValidationError
		require.ErrorAs(t, err, &ve, "%+v", c.t)
		require.Equal(t, c.field, ve.Field)
	}
	got, err := stats.LoadThresholds(ctx, q)
	require.NoError(t, err)
	require.Equal(t, 7, got.OfflineDays, "nothing was saved")
	for _, ok := range []stats.Thresholds{
		{OfflineDays: 1, PendingHours: 1, MinClientVersion: "1"},
		{OfflineDays: 365, PendingHours: 720, MinClientVersion: "1.2.3.4"},
	} {
		require.NoError(t, stats.SaveThresholds(ctx, q, ok))
	}
}

func TestSummaryHidesNonApprovedConflicts(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	for _, state := range []string{"pending", "rejected", "archived"} {
		id := e.addDevice(t, devSpec{rid: state, state: state})
		_, err := e.pool.Exec(ctx, `INSERT INTO device_alerts(device_id,kind) VALUES($1,'group_conflict')`, id)
		require.NoError(t, err)
	}
	got, err := stats.Summary(ctx, e.pool, nil, summaryNow)
	require.NoError(t, err)
	for _, a := range got.Attention {
		require.NotEqual(t, "group_conflict", a.Kind)
	}
}
