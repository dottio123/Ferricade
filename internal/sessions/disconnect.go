package sessions

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

var (
	// ErrNotFound is returned for a session that does not exist.
	ErrNotFound = errors.New("sessions: not found")
	// ErrEnded is returned when a disconnect is requested on a session that
	// has already ended.
	ErrEnded = errors.New("sessions: session ended")
)

// ActionDisconnectRequested is the audit action of a disconnect request.
const ActionDisconnectRequested = "session.disconnect_requested"

// RequestDisconnect asks for the open session id to be disconnected: the
// device's heartbeat reply will list its conn_id (SyncConns), and the session
// then ends as "disconnected". Asking again keeps the first request and
// writes no second audit entry. It returns ErrNotFound for an unknown session
// and ErrEnded for one that has ended.
func (s *Service) RequestDisconnect(ctx context.Context, a devices.Actor, id uuid.UUID) (Session, error) {
	var out Session
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		cur, err := q.LockRemoteSession(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return wrap("lock session", err)
		}
		if cur.EndedAt != nil {
			return ErrEnded
		}
		if cur.DisconnectRequestedAt == nil {
			now := s.now()
			if _, err := q.RequestRemoteSessionDisconnect(ctx, db.RequestRemoteSessionDisconnectParams{
				Now: &now, RequestedBy: &a.UserID, ID: id,
			}); err != nil {
				return wrap("request disconnect", err)
			}
			actor := a.UserID
			if err := audit.Record(ctx, q, audit.Event{
				ActorUserID: &actor, ActorIP: a.IP, Action: ActionDisconnectRequested,
				TargetType: "session", TargetID: id.String(),
				Details: map[string]any{"device_id": cur.DeviceID.String(), "conn_id": cur.ConnID},
			}); err != nil {
				return err
			}
		}
		r, err := q.GetRemoteSession(ctx, id)
		if err != nil {
			return wrap("read session", err)
		}
		now := s.now()
		out = Session{
			ID: r.ID, DeviceID: r.DeviceID, DeviceName: deviceName(r.Alias, r.Hostname, r.RustdeskID),
			RustdeskID: r.RustdeskID, PeerRustdeskID: r.PeerRustdeskID, PeerName: r.PeerName,
			Type: TypeName(r.Type), ClientIP: r.ClientIP, StartedAt: r.StartedAt.UTC(),
			AuthedAt: utc(r.AuthedAt), EndedAt: utc(r.EndedAt), EndReason: r.EndReason,
			DisconnectRequestedAt: utc(r.DisconnectRequestedAt),
			DurationSeconds:       seconds(r.StartedAt, r.EndedAt, now),
		}
		return nil
	})
	if err != nil {
		return Session{}, err
	}
	return out, nil
}
