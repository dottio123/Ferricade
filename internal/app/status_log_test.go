package app_test

import (
	"context"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/app"
	"github.com/dottio123/ferricade/internal/setup"
	"github.com/dottio123/ferricade/internal/store/db"
)

func TestStatusLineLogsFleetCounts(t *testing.T) {
	cfg, q := newConfig(t)
	ctx := context.Background()
	srv, err := q.CreateServer(ctx, db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=",
	})
	require.NoError(t, err)
	require.NoError(t, q.PutSetting(ctx, db.PutSettingParams{Key: setup.KeySetupComplete, Value: []byte(`true`)}))
	_, err = q.EnrollDevice(ctx, db.EnrollDeviceParams{ServerID: srv.ID, RustdeskID: "111", UUID: "dXVpZDE="})
	require.NoError(t, err)

	var logs syncBuffer
	a, err := app.New(ctx, cfg, slog.New(slog.NewJSONHandler(&logs, nil)))
	require.NoError(t, err)
	t.Cleanup(a.Close)

	a.LogStatus(ctx)

	var statusRec map[string]any
	for _, r := range logs.records(t) {
		if r["msg"] == "status" {
			statusRec = r
		}
	}
	require.NotNil(t, statusRec, "expected status log record")
	assert.Equal(t, "INFO", statusRec["level"])
	assert.Equal(t, float64(1), statusRec["devices_total"])
	assert.Equal(t, float64(0), statusRec["devices_online"])
	assert.Equal(t, float64(1), statusRec["devices_pending"])
	assert.Equal(t, float64(0), statusRec["open_sessions"])
}
