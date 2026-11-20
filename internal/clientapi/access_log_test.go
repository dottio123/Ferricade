package clientapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/clientapi"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/sessions"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func decodeClientLogs(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	dec := json.NewDecoder(bytes.NewReader(buf.Bytes()))
	for dec.More() {
		var r map[string]any
		require.NoError(t, dec.Decode(&r))
		out = append(out, r)
	}
	return out
}

func loggedLiveRoutes(t *testing.T, logs *bytes.Buffer) http.Handler {
	t.Helper()
	pool := store.NewTestDB(t)
	srv, err := db.New(pool).CreateServer(context.Background(), db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	svc := &devices.Service{Pool: pool, Beats: devices.NewTracker(time.Now), MaxPending: 100}
	return clientapi.Routes(clientapi.Deps{
		Devices:  svc,
		Sessions: &sessions.Service{Pool: pool},
		Setup:    setupState{srv.ID, true},
		Log:      slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
	})
}

func TestClientAccessLogLevelsAndRequestID(t *testing.T) {
	var logs bytes.Buffer
	h := loggedLiveRoutes(t, &logs)

	// 1. Heartbeat -> DEBUG with X-Request-ID and rustdesk_id.
	rec := do(h, http.MethodPost, "/api/heartbeat", `{"id":"998877","uuid":"dXVpZA=="}`)
	require.Equal(t, http.StatusOK, rec.Code)
	reqID := rec.Header().Get("X-Request-ID")
	require.Len(t, reqID, 32)

	records := decodeClientLogs(t, &logs)
	require.Len(t, records, 1)
	assert.Equal(t, "DEBUG", records[0]["level"])
	assert.Equal(t, http.MethodPost, records[0]["method"])
	assert.Equal(t, "/api/heartbeat", records[0]["path"])
	assert.Equal(t, float64(http.StatusOK), records[0]["status"])
	assert.Equal(t, reqID, records[0]["request_id"])
	assert.Equal(t, "998877", records[0]["rustdesk_id"])
	assert.Contains(t, records[0], "duration_ms")
	assert.Contains(t, records[0], "ip")

	// 2. Sysinfo -> INFO with X-Request-ID and rustdesk_id.
	logs.Reset()
	rec = do(h, http.MethodPost, "/api/sysinfo", `{"id":"998877","uuid":"dXVpZA==","hostname":"box"}`)
	require.Equal(t, http.StatusOK, rec.Code)
	reqID = rec.Header().Get("X-Request-ID")
	require.Len(t, reqID, 32)

	records = decodeClientLogs(t, &logs)
	require.Len(t, records, 1)
	assert.Equal(t, "INFO", records[0]["level"])
	assert.Equal(t, "/api/sysinfo", records[0]["path"])
	assert.Equal(t, reqID, records[0]["request_id"])
	assert.Equal(t, "998877", records[0]["rustdesk_id"])

	// 3. 400 on heartbeat -> INFO.
	logs.Reset()
	rec = do(h, http.MethodPost, "/api/heartbeat", `{`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	records = decodeClientLogs(t, &logs)
	require.Len(t, records, 1)
	assert.Equal(t, "INFO", records[0]["level"])
	assert.Equal(t, float64(http.StatusBadRequest), records[0]["status"])
}

func TestClientAccessLogRedaction(t *testing.T) {
	var logs bytes.Buffer
	h := loggedLiveRoutes(t, &logs)

	req := httptest.NewRequest(http.MethodPost, "/api/sysinfo?code=secret-query-code", strings.NewReader(`{"id":"111","uuid":"dXVpZA==","hostname":"secret-host-body"}`))
	req.RemoteAddr = "198.51.100.10:12345"
	req.AddCookie(&http.Cookie{Name: "ferricade_session", Value: "secret-cookie-val"})
	req.Header.Set("X-CSRF", "secret-csrf-val")
	req.Header.Set("X-Setup-Token", "secret-setup-tok")
	req.Header.Set("Authorization", "Bearer secret-auth-tok")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	raw := logs.String()
	require.NotEmpty(t, raw)
	for _, secret := range []string{
		"secret-query-code",
		"secret-host-body",
		"secret-cookie-val",
		"secret-csrf-val",
		"secret-setup-tok",
		"secret-auth-tok",
	} {
		assert.NotContains(t, raw, secret)
	}
}

func TestClientAccessLogFloodableAndClipID(t *testing.T) {
	var logs bytes.Buffer
	h := loggedLiveRoutes(t, &logs)

	// 1. 404 -> DEBUG.
	rec := do(h, http.MethodGet, "/api/nope", "")
	require.Equal(t, http.StatusNotFound, rec.Code)
	records := decodeClientLogs(t, &logs)
	require.Len(t, records, 1)
	assert.Equal(t, "DEBUG", records[0]["level"])
	assert.Equal(t, float64(http.StatusNotFound), records[0]["status"])

	// 2. Heartbeat rejects oversized IDs; audit/conn still clips its logged ID.
	logs.Reset()
	longID := strings.Repeat("9", 100)
	rec = do(h, http.MethodPost, "/api/heartbeat", `{"id":"`+longID+`","uuid":"dXVpZA=="}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.NotContains(t, decodeClientLogs(t, &logs)[0], "rustdesk_id")
	logs.Reset()
	rec = do(h, http.MethodPost, "/api/audit/conn", `{"id":"`+longID+`","uuid":"dXVpZA==","conn_id":1,"nonce":"n","action":"new"}`)
	require.Equal(t, http.StatusOK, rec.Code)
	records = decodeClientLogs(t, &logs)
	require.Len(t, records, 1)
	gotID, _ := records[0]["rustdesk_id"].(string)
	assert.Equal(t, strings.Repeat("9", 64)+"…", gotID)
}
