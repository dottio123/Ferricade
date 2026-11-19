package sessions

import (
	"context"
	"fmt"
	"math"
	"math/big"
	"net/netip"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

const (
	// MaxNonceLen is the longest nonce the client API accepts, in bytes.
	MaxNonceLen = 128
	// maxPeerLen caps the stored peer id and name, in characters.
	maxPeerLen = 128
)

// Ingest applies one connection audit record, in one transaction. Records
// from a device the heartbeat would not accept are dropped, as are records
// whose nonce was already applied. "new" opens a session (ending as stale
// any session still open on the same conn_id, which the client has reused),
// unless the open session was opened by an auth record that overtook this
// "new"; then it fills in that session's client_ip instead. An auth record (no action, with peer) fills in the peer and type and opens
// the session if needed, and "close" ends it. Anything else is ignored.
//
// ip is the address the record was posted from, which is the device itself;
// the session's client_ip is the peer address the record carries.
func (s *Service) Ingest(ctx context.Context, serverID uuid.UUID, a wire.ConnAudit, ip netip.Addr) error {
	now := s.now()
	return store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		deviceID, ok, err := devices.Lookup(ctx, q, serverID, a.ID, a.UUID)
		if err != nil || !ok {
			return err
		}
		fresh, err := q.InsertSeenNonce(ctx, db.InsertSeenNonceParams{Nonce: a.Nonce, SeenAt: now})
		if err != nil {
			return wrap("record nonce", err)
		}
		if fresh == 0 {
			return nil // a retried post
		}

		switch {
		case a.Action == wire.ConnActionNew:
			merged, err := q.MergeNewIntoAuthedRemoteSession(ctx, db.MergeNewIntoAuthedRemoteSessionParams{
				ClientIP: peerAddr(a.IP), RDSessionID: rdSessionID(a.SessionID), Now: now,
				DeviceID: deviceID, ConnID: a.ConnID,
			})
			if err != nil {
				return wrap("merge late new", err)
			}
			if merged > 0 {
				return nil
			}
			if err := q.EndOpenRemoteSessionStale(ctx, db.EndOpenRemoteSessionStaleParams{
				DeviceID: deviceID, ConnID: a.ConnID,
			}); err != nil {
				return wrap("end reused conn", err)
			}
			if err := q.OpenRemoteSession(ctx, db.OpenRemoteSessionParams{
				DeviceID: deviceID, ConnID: a.ConnID, RDSessionID: rdSessionID(a.SessionID),
				ClientIP: peerAddr(a.IP), Now: now,
			}); err != nil {
				return wrap("open session", err)
			}
		case a.Action == "" && len(a.Peer) > 0:
			var name string
			if len(a.Peer) > 1 {
				name = a.Peer[1]
			}
			if err := q.AuthRemoteSession(ctx, db.AuthRemoteSessionParams{
				DeviceID: deviceID, ConnID: a.ConnID, RDSessionID: rdSessionID(a.SessionID),
				PeerRustdeskID: clip(a.Peer[0]), PeerName: clip(name), Type: sessionType(a.Type), Now: now,
			}); err != nil {
				return wrap("record auth", err)
			}
		case a.Action == wire.ConnActionClose:
			if err := q.CloseRemoteSession(ctx, db.CloseRemoteSessionParams{
				Now: now, DeviceID: deviceID, ConnID: a.ConnID,
			}); err != nil {
				return wrap("close session", err)
			}
		}
		return nil
	})
}

// rdSessionID is the client's u64 session_id as numeric(20), NULL for 0. It
// goes through big.Int because it does not fit an int64.
func rdSessionID(v uint64) pgtype.Numeric {
	if v == 0 {
		return pgtype.Numeric{}
	}
	return pgtype.Numeric{Int: new(big.Int).SetUint64(v), Valid: true}
}

// peerAddr parses the record's peer address, nil when it is not one. An
// IPv4-mapped address is stored as IPv4, and a zone (which inet cannot hold)
// is dropped.
func peerAddr(s string) *netip.Addr {
	addr, err := netip.ParseAddr(s)
	if err != nil {
		ap, err := netip.ParseAddrPort(s)
		if err != nil {
			return nil
		}
		addr = ap.Addr()
	}
	addr = addr.Unmap().WithZone("")
	return &addr
}

// sessionType is the record's type as stored; a code that does not fit
// smallint is unknown (NULL), as is a negative one.
func sessionType(t *int) *int16 {
	if t == nil || *t < 0 || *t > math.MaxInt16 {
		return nil
	}
	v := int16(*t)
	return &v
}

// clip cuts s to maxPeerLen characters.
func clip(s string) string {
	if utf8.RuneCountInString(s) <= maxPeerLen {
		return s
	}
	return string([]rune(s)[:maxPeerLen])
}

func wrap(what string, err error) error { return fmt.Errorf("sessions: %s: %w", what, err) }
