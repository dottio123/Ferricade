package clientapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/clientapi"
	"github.com/dottio123/ferricade/internal/idalarms"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func TestAuditAlarmWindows(t *testing.T) {
	ctx := context.Background()
	pool := store.NewTestDB(t)
	srv, err := db.New(pool).CreateServer(ctx, db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	deviceID, devUUID := "123456789", "ZmFrZS11dWlk"
	_, err = pool.Exec(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, $2, $3, 'approved')`, srv.ID, deviceID, devUUID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, 'pending-1', $2, 'pending')`, srv.ID, devUUID)
	require.NoError(t, err)
	start := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
	now := start
	alarms := &idalarms.Service{Pool: pool, Now: func() time.Time { return now }}
	h := clientapi.Routes(clientapi.Deps{Setup: setupState{srv.ID, true}, IDAlarms: alarms})
	post := func(id, reportedUUID string, typ int) *httptest.ResponseRecorder {
		t.Helper()
		info, err := json.Marshal(map[string]string{"id": "blocked-1", "ip": "203.0.113.7", "name": "blocked client"})
		require.NoError(t, err)
		body, err := json.Marshal(map[string]any{"id": id, "uuid": reportedUUID, "typ": typ, "info": string(info), "conn_id": 3, "nonce": uuid.NewString()})
		require.NoError(t, err)
		return do(h, http.MethodPost, "/api/audit/alarm", string(body))
	}
	count := func(action string) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = $1`, action).Scan(&n))
		return n
	}

	require.Equal(t, http.StatusOK, post("pending-1", devUUID, 10).Code, "unapproved device ignored")
	require.Equal(t, http.StatusOK, post(deviceID, "other-uuid", 10).Code, "uuid mismatch ignored")
	require.Equal(t, http.StatusOK, post(deviceID, devUUID, 3).Code, "other alarm ignored")
	assert.Zero(t, count("device.id_blocked"))

	require.Equal(t, http.StatusOK, post(deviceID, devUUID, 10).Code)
	assert.Equal(t, 1, count("device.id_blocked"))
	for i := 0; i < 3; i++ {
		now = now.Add(time.Minute)
		require.Equal(t, http.StatusOK, post(deviceID, devUUID, 10).Code)
	}
	assert.Equal(t, 1, count("device.id_blocked"), "repeats are not logged individually")
	now = start.Add(11 * time.Minute)
	require.NoError(t, alarms.SweepExpired(ctx))
	assert.Equal(t, 1, count("device.id_blocked_repeated"))
	var details map[string]any
	require.NoError(t, pool.QueryRow(ctx, `SELECT details FROM audit_events WHERE action = 'device.id_blocked_repeated'`).Scan(&details))
	assert.Equal(t, "blocked-1", details["id"])
	assert.Equal(t, float64(3), details["count"])
	assert.Equal(t, start.Format(time.RFC3339Nano), details["first_seen"])
	assert.Equal(t, start.Add(3*time.Minute).Format(time.RFC3339Nano), details["last_seen"])
	var windows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM id_blocked_alarm_windows`).Scan(&windows))
	assert.Zero(t, windows)

	require.Equal(t, http.StatusOK, post(deviceID, devUUID, 10).Code)
	assert.Equal(t, 2, count("device.id_blocked"), "alarm after close starts a new window")
}

func TestAuditAlarmClosesExpiredWindowBeforeOpeningNext(t *testing.T) {
	h := newAlarmHarness(t)
	require.Equal(t, http.StatusOK, h.post("blocked-1", "203.0.113.7", "first").Code)
	h.now = h.now.Add(time.Minute)
	require.Equal(t, http.StatusOK, h.post("blocked-1", "203.0.113.7", "repeat").Code)
	h.now = h.now.Add(10*time.Minute + time.Second)
	require.Equal(t, http.StatusOK, h.post("blocked-1", "203.0.113.7", "second").Code)
	require.Equal(t, 2, h.count("device.id_blocked"))
	require.Equal(t, 1, h.count("device.id_blocked_repeated"))
	var open int
	require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT count(*) FROM id_blocked_alarm_windows`).Scan(&open))
	require.Equal(t, 1, open)
}

func TestAuditAlarmBudgetUsesOverflowSummary(t *testing.T) {
	h := newAlarmHarness(t)
	for i := 0; i < 20; i++ {
		require.Equal(t, http.StatusOK, h.post(fmt.Sprintf("blocked-%d", i), "203.0.113.7", "name").Code)
	}
	require.Equal(t, http.StatusOK, h.post("blocked-overflow", "203.0.113.7", "name").Code)
	require.Equal(t, 20, h.count("device.id_blocked"))
	var open, overflow int
	require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT count(*) FROM id_blocked_alarm_windows`).Scan(&open))
	require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT count(*) FROM id_blocked_alarm_overflow`).Scan(&overflow))
	require.Equal(t, 20, open)
	require.Equal(t, 1, overflow)
	h.now = h.now.Add(11 * time.Minute)
	require.NoError(t, h.alarms.SweepExpired(h.ctx))
	require.Equal(t, 1, h.count("device.id_blocked_overflow"))
	var details map[string]any
	require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT details FROM audit_events WHERE action = 'device.id_blocked_overflow'`).Scan(&details))
	require.Equal(t, float64(1), details["count"])
	require.NotEmpty(t, details["first_seen"])
	require.NotEmpty(t, details["last_seen"])
}

func TestAuditAlarmBounds(t *testing.T) {
	h := newAlarmHarness(t)
	require.Equal(t, http.StatusOK, h.post(strings.Repeat("x", 65), "ip", "name").Code)
	require.Equal(t, 0, h.count("device.id_blocked"))
	var normal, overflow int
	require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT count(*) FROM id_blocked_alarm_windows`).Scan(&normal))
	require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT count(*) FROM id_blocked_alarm_overflow`).Scan(&overflow))
	require.Zero(t, normal)
	require.Zero(t, overflow)
	require.Equal(t, http.StatusOK, h.post("blocked-1", strings.Repeat("é", 300), strings.Repeat("名", 300)).Code)
	var details map[string]any
	require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT details FROM audit_events WHERE action = 'device.id_blocked'`).Scan(&details))
	assert.Equal(t, 64, len([]rune(details["ip"].(string))))
	assert.Equal(t, 128, len([]rune(details["name"].(string))))
}

func TestAuditAlarmSurvivesSweepDeleteInterleaving(t *testing.T) {
	h := newAlarmHarness(t)
	require.Equal(t, http.StatusOK, h.post("blocked-1", "203.0.113.7", "first").Code)
	tx, err := h.pool.Begin(h.ctx)
	require.NoError(t, err)
	var deviceUUID uuid.UUID
	require.NoError(t, tx.QueryRow(h.ctx, `SELECT id FROM devices WHERE rustdesk_id = '123456789'`).Scan(&deviceUUID))
	_, err = tx.Exec(h.ctx, `SELECT 1 FROM devices WHERE id = $1 FOR UPDATE`, deviceUUID)
	require.NoError(t, err)
	_, err = tx.Exec(h.ctx, `SELECT 1 FROM id_blocked_alarm_windows WHERE device_id = $1 AND blocked_id = 'blocked-1' FOR UPDATE`, deviceUUID)
	require.NoError(t, err)
	finished := make(chan *httptest.ResponseRecorder, 1)
	go func() { finished <- h.post("blocked-1", "203.0.113.7", "second") }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT EXISTS (
			SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND (query LIKE '%FROM devices%' OR query LIKE '%id_blocked_alarm_windows%')
		)`).Scan(&waiting))
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Record did not reach the locked alarm window")
		}
		runtime.Gosched()
	}
	_, err = tx.Exec(h.ctx, `DELETE FROM id_blocked_alarm_windows WHERE device_id = $1 AND blocked_id = 'blocked-1'`, deviceUUID)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(h.ctx))
	require.Equal(t, http.StatusOK, (<-finished).Code)
	require.Equal(t, 2, h.count("device.id_blocked"), "new alarm window must remain after the sweep deletes the old one")
	var windows int
	require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT count(*) FROM id_blocked_alarm_windows WHERE device_id = $1`, deviceUUID).Scan(&windows))
	require.Equal(t, 1, windows)
}

type alarmHarness struct {
	t       *testing.T
	ctx     context.Context
	pool    *pgxpool.Pool
	alarms  *idalarms.Service
	now     time.Time
	handler http.Handler
}

func newAlarmHarness(t *testing.T) *alarmHarness {
	t.Helper()
	ctx := context.Background()
	pool := store.NewTestDB(t)
	srv, err := db.New(pool).CreateServer(ctx, db.CreateServerParams{Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com", PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="})
	require.NoError(t, err)
	deviceID, devUUID := "123456789", "ZmFrZS11dWlk"
	_, err = pool.Exec(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, $2, $3, 'approved')`, srv.ID, deviceID, devUUID)
	require.NoError(t, err)
	start := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
	h := &alarmHarness{t: t, ctx: ctx, pool: pool, now: start}
	h.alarms = &idalarms.Service{Pool: pool, Now: func() time.Time { return h.now }}
	h.handler = clientapi.Routes(clientapi.Deps{Setup: setupState{srv.ID, true}, IDAlarms: h.alarms})
	return h
}

func (h *alarmHarness) post(blockedID, ip, name string) *httptest.ResponseRecorder {
	return h.postAlarm("123456789", "ZmFrZS11dWlk", 10, blockedID, ip, name)
}

func (h *alarmHarness) postAlarm(deviceID, deviceUUID string, typ int, blockedID, ip, name string) *httptest.ResponseRecorder {
	h.t.Helper()
	info, err := json.Marshal(map[string]string{"id": blockedID, "ip": ip, "name": name, "password": "must not persist"})
	require.NoError(h.t, err)
	body, err := json.Marshal(map[string]any{"id": deviceID, "uuid": deviceUUID, "typ": typ, "info": string(info), "conn_id": 3, "nonce": uuid.NewString()})
	require.NoError(h.t, err)
	return do(h.handler, http.MethodPost, "/api/audit/alarm", string(body))
}

func TestLockoutAlarmValidationAndDetails(t *testing.T) {
	h := newAlarmHarness(t)
	_, err := h.pool.Exec(h.ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, state)
		SELECT server_id, 'pending-1', uuid, 'pending' FROM devices WHERE rustdesk_id = '123456789'`)
	require.NoError(t, err)
	for _, typ := range []int{1, 2, 6} {
		for _, device := range []struct{ id, uuid string }{{"pending-1", "ZmFrZS11dWlk"}, {"123456789", "wrong"}, {"unknown", "ZmFrZS11dWlk"}} {
			require.Equal(t, http.StatusOK, h.postAlarm(device.id, device.uuid, typ, "remote", "ip", "name").Code)
		}
		require.Equal(t, http.StatusOK, h.postAlarm("123456789", "ZmFrZS11dWlk", typ, strings.Repeat("名", 65), "ip", "name").Code)
	}
	for _, typ := range []int{3, 7, 9, 999} {
		require.Equal(t, http.StatusOK, h.postAlarm("123456789", "ZmFrZS11dWlk", typ, "remote", "ip", "name").Code)
	}
	require.Zero(t, h.count("device.login_locked_out"))
	var windows int
	require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT count(*) FROM id_blocked_alarm_windows`).Scan(&windows))
	require.Zero(t, windows)
	for typ, reason := range map[int]string{1: "too_many_attempts", 2: "too_many_per_minute", 6: "ipv6_prefix"} {
		for _, device := range []struct{ id, uuid string }{{"", "ZmFrZS11dWlk"}, {"123456789", ""}, {"123456789", "\x00"}} {
			require.Equal(t, http.StatusBadRequest, h.postAlarm(device.id, device.uuid, typ, "remote", "ip", "name").Code)
		}
		for _, info := range []string{`{`, `{}`, `{"id":4}`, `{"id":"remote","name":"\u0000"}`} {
			body, err := json.Marshal(map[string]any{"id": "123456789", "uuid": "ZmFrZS11dWlk", "typ": typ, "info": info})
			require.NoError(t, err)
			require.Equal(t, http.StatusBadRequest, do(h.handler, http.MethodPost, "/api/audit/alarm", string(body)).Code)
		}
		require.Equal(t, http.StatusOK, h.postAlarm("123456789", "ZmFrZS11dWlk", typ, "remote", strings.Repeat("é", 65), strings.Repeat("名", 129)).Code)
		var details map[string]any
		require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT details FROM audit_events WHERE action = 'device.login_locked_out' AND details->>'reason' = $1`, reason).Scan(&details))
		require.Equal(t, map[string]any{"rustdesk_id": "remote", "ip": strings.Repeat("é", 64), "name": strings.Repeat("名", 128), "reason": reason}, details)
	}
	require.Equal(t, 3, h.count("device.login_locked_out"))
}

func TestLockoutAlarmWindowsPerReason(t *testing.T) {
	h := newAlarmHarness(t)
	start := h.now
	for _, typ := range []int{1, 2, 6} {
		require.Equal(t, http.StatusOK, h.postAlarm("123456789", "ZmFrZS11dWlk", typ, "remote", "203.0.113.7", "first").Code)
	}
	require.Equal(t, http.StatusOK, h.post("remote", "ip", "name").Code)
	for i, typ := range []int{1, 2, 6} {
		for j := 0; j <= i; j++ {
			h.now = start.Add(time.Minute)
			require.Equal(t, http.StatusOK, h.postAlarm("123456789", "ZmFrZS11dWlk", typ, "remote", "changed", "changed").Code)
		}
	}
	require.Equal(t, 3, h.count("device.login_locked_out"))
	require.Zero(t, h.count("device.login_locked_out_repeated"))
	h.now = start.Add(10 * time.Minute)
	// Record closes one reason; the sweep closes the other reasons exactly once.
	require.Equal(t, http.StatusOK, h.postAlarm("123456789", "ZmFrZS11dWlk", 1, "remote", "new", "new").Code)
	require.NoError(t, h.alarms.SweepExpired(h.ctx))
	require.NoError(t, h.alarms.SweepExpired(h.ctx))
	require.Equal(t, 4, h.count("device.login_locked_out"))
	require.Equal(t, 1, h.count("device.id_blocked"))
	require.Equal(t, 3, h.count("device.login_locked_out_repeated"))
	for i, reason := range []string{"too_many_attempts", "too_many_per_minute", "ipv6_prefix"} {
		var details map[string]any
		require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT details FROM audit_events WHERE action = 'device.login_locked_out_repeated' AND details->>'reason' = $1`, reason).Scan(&details))
		require.Equal(t, map[string]any{"rustdesk_id": "remote", "ip": "203.0.113.7", "name": "first", "reason": reason,
			"count": float64(i + 1), "first_seen": start.Format(time.RFC3339Nano), "last_seen": start.Add(time.Minute).Format(time.RFC3339Nano)}, details)
	}
}

func TestLockoutAlarmSharesOverflowBudget(t *testing.T) {
	h := newAlarmHarness(t)
	for i := 0; i < 19; i++ {
		require.Equal(t, http.StatusOK, h.post(fmt.Sprintf("blocked-%d", i), "ip", "name").Code)
	}
	require.Equal(t, http.StatusOK, h.postAlarm("123456789", "ZmFrZS11dWlk", 1, "remote", "ip", "name").Code)
	for _, typ := range []int{2, 6} {
		require.Equal(t, http.StatusOK, h.postAlarm("123456789", "ZmFrZS11dWlk", typ, "remote", "ip", "name").Code)
	}
	require.Equal(t, 1, h.count("device.login_locked_out"))
	h.now = h.now.Add(10 * time.Minute)
	require.NoError(t, h.alarms.SweepExpired(h.ctx))
	require.Equal(t, 1, h.count("device.id_blocked_overflow"))
	var details map[string]any
	require.NoError(t, h.pool.QueryRow(h.ctx, `SELECT details FROM audit_events WHERE action = 'device.id_blocked_overflow'`).Scan(&details))
	require.Len(t, details, 3)
	require.Equal(t, float64(2), details["count"])
}

func (h *alarmHarness) count(action string) int {
	h.t.Helper()
	var n int
	require.NoError(h.t, h.pool.QueryRow(h.ctx, `SELECT count(*) FROM audit_events WHERE action = $1`, action).Scan(&n))
	return n
}
