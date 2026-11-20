package idalarms

import (
	"context"
	"net/netip"
	"testing"
	"time"

	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
	"github.com/stretchr/testify/require"
)

func TestRecordMismatchedUUIDDoesNotWaitForDeviceLock(t *testing.T) {
	ctx := context.Background()
	pool := store.NewTestDB(t)
	srv, err := db.New(pool).CreateServer(ctx, db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	var deviceID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO devices (server_id,rustdesk_id,uuid,state) VALUES ($1,'123','pinned','approved') RETURNING id`, srv.ID).Scan(&deviceID))
	locker, err := pool.Begin(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = locker.Rollback(ctx) })
	_, err = locker.Exec(ctx, `SELECT id FROM devices WHERE id=$1 FOR UPDATE`, deviceID)
	require.NoError(t, err)

	callCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	err = (&Service{Pool: pool}).Record(callCtx, Alarm{ServerID: srv.ID, DeviceID: "123", DeviceUUID: "wrong", ActorIP: netip.MustParseAddr("192.0.2.1")})
	require.NoError(t, err)
}
