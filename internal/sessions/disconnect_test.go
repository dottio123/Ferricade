package sessions_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/sessions"
)

func (e *env) actor(t *testing.T) devices.Actor {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, e.pool.QueryRow(context.Background(),
		`INSERT INTO users (username, role, password_hash) VALUES ($1, 'admin', 'x') RETURNING id`,
		"admin-"+uuid.NewString()).Scan(&id))
	return devices.Actor{UserID: id, IP: peerIP}
}

func auditRows(t *testing.T, e *env) []struct {
	Action, TargetType, TargetID string
	Details                      map[string]any
} {
	t.Helper()
	rs, err := e.pool.Query(context.Background(),
		`SELECT action, target_type, target_id, details FROM audit_events WHERE action = 'session.disconnect_requested' ORDER BY at, id`)
	require.NoError(t, err)
	defer rs.Close()
	var out []struct {
		Action, TargetType, TargetID string
		Details                      map[string]any
	}
	for rs.Next() {
		var r struct {
			Action, TargetType, TargetID string
			Details                      map[string]any
		}
		var raw []byte
		require.NoError(t, rs.Scan(&r.Action, &r.TargetType, &r.TargetID, &raw))
		require.NoError(t, json.Unmarshal(raw, &r.Details))
		out = append(out, r)
	}
	require.NoError(t, rs.Err())
	return out
}

func TestRequestDisconnect(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, "approved")
	act := e.actor(t)
	e.ingest(t, fixture(t, "new")) // conn 3
	id := rows(t, e.pool)[0].ID

	e.now = t0.Add(time.Minute)
	s, err := e.svc.RequestDisconnect(ctx, act, id)
	require.NoError(t, err)
	require.NotNil(t, s.DisconnectRequestedAt)
	assert.Equal(t, e.now, *s.DisconnectRequestedAt)
	assert.Equal(t, id, s.ID)
	assert.Nil(t, s.EndedAt)

	// Repeating keeps the first time and adds no second audit row.
	e.now = t0.Add(2 * time.Minute)
	again, err := e.svc.RequestDisconnect(ctx, act, id)
	require.NoError(t, err)
	assert.Equal(t, t0.Add(time.Minute), *again.DisconnectRequestedAt)
	a := auditRows(t, e)
	require.Len(t, a, 1)
	assert.Equal(t, "session", a[0].TargetType)
	assert.Equal(t, id.String(), a[0].TargetID)
	assert.Equal(t, e.deviceID.String(), a[0].Details["device_id"])
	assert.EqualValues(t, 3, a[0].Details["conn_id"])

	_, err = e.svc.RequestDisconnect(ctx, act, uuid.New())
	assert.ErrorIs(t, err, sessions.ErrNotFound)

	e.ingest(t, fixture(t, "close"))
	_, err = e.svc.RequestDisconnect(ctx, act, id)
	assert.ErrorIs(t, err, sessions.ErrEnded)
}

func TestRequestDisconnectEndedNotRequested(t *testing.T) {
	e := newEnv(t, "approved")
	e.ingest(t, fixture(t, "new"))
	e.ingest(t, fixture(t, "close"))
	_, err := e.svc.RequestDisconnect(context.Background(), e.actor(t), rows(t, e.pool)[0].ID)
	assert.ErrorIs(t, err, sessions.ErrEnded)
	assert.Empty(t, auditRows(t, e))
}

func TestSyncConnsReturnsPendingDisconnects(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, "approved")
	other := e.addDevice(t, "222222222", "b3RoZXI=", "approved")
	_ = other
	act := e.actor(t)
	e.ingest(t, fixture(t, "new")) // conn 3
	o := with(fixture(t, "new"), 3, "other-3")
	o.ID, o.UUID = "222222222", "b3RoZXI="
	e.ingest(t, o)

	got, err := e.svc.SyncConns(ctx, e.serverID, devID, devUUID, []int32{3})
	require.NoError(t, err)
	assert.Empty(t, got, "nothing requested yet")

	for _, r := range rows(t, e.pool) {
		if r.DeviceID == e.deviceID {
			_, err := e.svc.RequestDisconnect(ctx, act, r.ID)
			require.NoError(t, err)
		}
	}

	got, err = e.svc.SyncConns(ctx, e.serverID, devID, devUUID, []int32{3, 9})
	require.NoError(t, err)
	assert.Equal(t, []int32{3}, got)

	got, err = e.svc.SyncConns(ctx, e.serverID, "222222222", "b3RoZXI=", []int32{3})
	require.NoError(t, err)
	assert.Empty(t, got, "another device's session is not asked to disconnect")

	got, err = e.svc.SyncConns(ctx, e.serverID, devID, devUUID, []int32{9})
	require.NoError(t, err)
	assert.Empty(t, got, "a conn the heartbeat no longer reports")

	got, err = e.svc.SyncConns(ctx, e.serverID, devID, "b3RoZXI=", []int32{3})
	require.NoError(t, err)
	assert.Empty(t, got, "wrong uuid")

	e.ingest(t, fixture(t, "close"))
	got, err = e.svc.SyncConns(ctx, e.serverID, devID, devUUID, []int32{3})
	require.NoError(t, err)
	assert.Empty(t, got, "ended")
}

func TestRequestedSessionsEndAsDisconnected(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, "approved")
	act := e.actor(t)
	request := func(conn int32) {
		for _, r := range rows(t, e.pool) {
			if r.ConnID == conn && r.EndedAt == nil {
				_, err := e.svc.RequestDisconnect(ctx, act, r.ID)
				require.NoError(t, err)
			}
		}
	}
	reason := func(conn int32) string {
		for _, r := range rows(t, e.pool) {
			if r.ConnID == conn {
				require.NotNil(t, r.EndReason)
				return *r.EndReason
			}
		}
		t.Fatal("no row")
		return ""
	}

	e.ingest(t, fixture(t, "new")) // conn 3, requested, then closed by the client
	request(3)
	e.ingest(t, fixture(t, "close"))
	assert.Equal(t, "disconnected", reason(3))

	e.ingest(t, with(fixture(t, "new"), 4, "new-4")) // conn 4, requested, then stale
	e.ingest(t, with(fixture(t, "new"), 5, "new-5")) // conn 5, never requested, stale
	request(4)
	e.now = t0.Add(5 * time.Minute)
	_, err := e.svc.SyncConns(ctx, e.serverID, devID, devUUID, []int32{})
	require.NoError(t, err)
	assert.Equal(t, "disconnected", reason(4))
	assert.Equal(t, "stale", reason(5))

	e.ingest(t, with(fixture(t, "new"), 6, "new-6")) // swept by CloseStale
	request(6)
	e.now = e.now.Add(5 * time.Minute)
	_, err = e.svc.CloseStale(ctx)
	require.NoError(t, err)
	assert.Equal(t, "disconnected", reason(6))

	// Unrequested sessions still end closed.
	e.ingest(t, with(fixture(t, "new"), 7, "new-7"))
	c := with(fixture(t, "close"), 7, "close-7")
	e.ingest(t, c)
	assert.Equal(t, "closed", reason(7))
}

func TestSessionNotifyOnDisconnectRequest(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	e := newEnv(t, "approved")
	e.ingest(t, fixture(t, "new"))
	id := rows(t, e.pool)[0].ID
	act := e.actor(t)
	listener, err := e.pool.Acquire(ctx)
	require.NoError(t, err)
	defer listener.Release()
	_, err = listener.Exec(ctx, "LISTEN ferricade_events")
	require.NoError(t, err)

	_, err = e.svc.RequestDisconnect(ctx, act, id)
	require.NoError(t, err)
	var ev struct {
		Kind, Op  string
		SessionID uuid.UUID `json:"session_id"`
	}
	// The audit entry announces itself too; only session events matter here.
	next := func() {
		t.Helper()
		for {
			n, err := listener.Conn().WaitForNotification(ctx)
			require.NoError(t, err)
			ev.Kind, ev.Op = "", ""
			require.NoError(t, json.Unmarshal([]byte(n.Payload), &ev), n.Payload)
			if ev.Kind == "session" {
				return
			}
		}
	}
	next()
	assert.Equal(t, "session", ev.Kind)
	assert.Equal(t, "updated", ev.Op)
	assert.Equal(t, id, ev.SessionID)

	// The repeat changes nothing, so announces nothing; the end is next.
	_, err = e.svc.RequestDisconnect(ctx, act, id)
	require.NoError(t, err)
	e.ingest(t, fixture(t, "close"))
	next()
	assert.Equal(t, "ended", ev.Op)
}
