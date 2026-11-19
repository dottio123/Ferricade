// Package sessions keeps the history of remote sessions to devices, built
// from the connection audit records RustDesk clients post to
// /api/audit/conn and kept current by the conns each heartbeat reports
// (spec, "Backend additions"). Rows live in the remote_sessions table; the
// sessions table holds admin logins.
package sessions

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// StaleAfter is how long an open session's conn_id may be missing from its
// device's heartbeats before the session is ended as stale.
const StaleAfter = 60 * time.Second

// Service records remote sessions for the client API.
type Service struct {
	Pool *pgxpool.Pool
	Now  func() time.Time // defaults to time.Now
}

// SyncConns applies a heartbeat's conns to the device's open sessions: those
// on a reported conn_id are marked seen now, and those missing whose
// conn_id was last seen more than StaleAfter ago end as stale, at that last
// sighting. It returns the conn_ids, among those reported, of sessions an admin
// asked to disconnect (RequestDisconnect): the heartbeat reply lists them.
// It does nothing for a device the heartbeat would not accept.
func (s *Service) SyncConns(ctx context.Context, serverID uuid.UUID, rustdeskID, devUUID string, conns []int32) ([]int32, error) {
	now := s.now()
	if conns == nil {
		conns = []int32{} // a NULL array would match no conn_id in "<> ALL"
	}
	var pending []int32
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		deviceID, ok, err := devices.Lookup(ctx, q, serverID, rustdeskID, devUUID)
		if err != nil || !ok {
			return err
		}
		pending, err = syncDeviceConns(ctx, q, deviceID, devUUID, conns, now)
		return err
	})
	if err != nil {
		return nil, err
	}
	return pending, nil
}

// SyncConnsForDevice applies conns after Heartbeat has already accepted the device.
func (s *Service) SyncConnsForDevice(ctx context.Context, deviceID uuid.UUID, devUUID string, conns []int32) ([]int32, error) {
	if conns == nil {
		conns = []int32{}
	}
	var pending []int32
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		var err error
		pending, err = syncDeviceConns(ctx, q, deviceID, devUUID, conns, s.now())
		return err
	})
	if err != nil {
		return nil, err
	}
	return pending, nil
}

func syncDeviceConns(ctx context.Context, q *db.Queries, deviceID uuid.UUID, devUUID string, conns []int32, now time.Time) ([]int32, error) {
	if len(conns) > 0 {
		if err := q.TouchRemoteSessionConns(ctx, db.TouchRemoteSessionConnsParams{Now: now, DeviceID: deviceID, DevUuid: devUUID, Conns: conns}); err != nil {
			return nil, wrap("mark conns seen", err)
		}
	}
	if err := q.EndStaleRemoteSessions(ctx, db.EndStaleRemoteSessionsParams{DeviceID: deviceID, DevUuid: devUUID, Conns: conns, Cutoff: now.Add(-StaleAfter)}); err != nil {
		return nil, wrap("end stale sessions", err)
	}
	if len(conns) == 0 {
		return nil, nil
	}
	pending, err := q.PendingDisconnectConns(ctx, db.PendingDisconnectConnsParams{DeviceID: deviceID, DevUuid: devUUID, Conns: conns})
	if err != nil {
		return nil, wrap("find disconnect requests", err)
	}
	return pending, nil
}

func (s *Service) now() time.Time {
	if s.Now == nil {
		return time.Now().UTC()
	}
	return s.Now().UTC()
}

// CloseStale ends, as stale, every open session last seen more than
// StaleAfter ago, whichever device it belongs to, and returns how many. The
// per-heartbeat sweep never runs for a device that stopped beating.
func (s *Service) CloseStale(ctx context.Context) (int64, error) {
	n, err := db.New(s.Pool).CloseStaleRemoteSessions(ctx, s.now().Add(-StaleAfter))
	if err != nil {
		return 0, wrap("close stale sessions", err)
	}
	return n, nil
}
