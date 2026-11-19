package devices_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/netip"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func TestApproveLogsInfoWithRustdeskIDAndActor(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	srv, err := db.New(pool).CreateServer(ctx, db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	devID, err := db.New(pool).EnrollDevice(ctx, db.EnrollDeviceParams{
		ServerID: srv.ID, RustdeskID: "555123", UUID: "dXVpZA==",
	})
	require.NoError(t, err)

	var logs bytes.Buffer
	svc := &devices.Service{
		Pool:       pool,
		Beats:      devices.NewTracker(time.Now),
		MaxPending: 100,
		Log:        slog.New(slog.NewJSONHandler(&logs, nil)),
	}
	u, err := db.New(pool).CreateUser(ctx, db.CreateUserParams{
		Username: "alice", Role: "admin",
	})
	require.NoError(t, err)
	actor := devices.Actor{UserID: u.ID, IP: netip.MustParseAddr("127.0.0.1")}
	err = svc.Transition(ctx, actor, devID, devices.StateApproved, devices.StatePending)
	require.NoError(t, err)

	dec := json.NewDecoder(&logs)
	var records []map[string]any
	for dec.More() {
		var r map[string]any
		require.NoError(t, dec.Decode(&r))
		records = append(records, r)
	}
	require.Len(t, records, 1)
	assert.Equal(t, "INFO", records[0]["level"])
	assert.Equal(t, "device approved", records[0]["msg"])
	assert.Equal(t, "555123", records[0]["rustdesk_id"])
	assert.Equal(t, u.ID.String(), records[0]["actor"])
}
