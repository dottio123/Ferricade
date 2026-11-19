package adminapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func decodeJSONLogs(t *testing.T, buf *bytes.Buffer) []map[string]any {
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

func TestAccessLogLevelsAndRequestID(t *testing.T) {
	var logs bytes.Buffer
	e := newEnv(t, func(d *Deps) {
		d.Log = slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	})
	e.markSetupComplete()
	e.createUser("owner", userOpts{role: "owner"})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("owner", goodPassword).Code)
	logs.Reset()

	// 1. Successful GET -> DEBUG only.
	rec := c.do(http.MethodGet, apiPrefix+"/devices", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	reqID := rec.Header().Get(headerRequestID)
	require.Len(t, reqID, 32)

	records := decodeJSONLogs(t, &logs)
	require.Len(t, records, 1)
	assert.Equal(t, "DEBUG", records[0]["level"])
	assert.Equal(t, http.MethodGet, records[0]["method"])
	assert.Equal(t, apiPrefix+"/devices", records[0]["route"])
	assert.Equal(t, float64(http.StatusOK), records[0]["status"])
	assert.Equal(t, reqID, records[0]["request_id"])
	assert.Equal(t, "owner", records[0]["user"])
	assert.Contains(t, records[0], "duration_ms")
	assert.Contains(t, records[0], "ip")

	// 2. Mutating request -> INFO with matching request_id.
	logs.Reset()
	rec = c.do(http.MethodPost, apiPrefix+"/groups", map[string]string{"name": "ops"})
	require.Equal(t, http.StatusCreated, rec.Code)
	reqID = rec.Header().Get(headerRequestID)
	require.Len(t, reqID, 32)

	records = decodeJSONLogs(t, &logs)
	require.Len(t, records, 1)
	assert.Equal(t, "INFO", records[0]["level"])
	assert.Equal(t, http.MethodPost, records[0]["method"])
	assert.Equal(t, apiPrefix+"/groups", records[0]["route"])
	assert.Equal(t, float64(http.StatusCreated), records[0]["status"])
	assert.Equal(t, reqID, records[0]["request_id"])
	assert.Equal(t, "owner", records[0]["user"])

	// 3. 500 -> WARN access log.
	logs.Reset()
	e.d.Pool.Close()
	rec = c.do(http.MethodGet, apiPrefix+"/devices", nil)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	reqID = rec.Header().Get(headerRequestID)

	records = decodeJSONLogs(t, &logs)
	var sawWarn bool
	for _, r := range records {
		if r["level"] == "WARN" && r["status"] == float64(http.StatusInternalServerError) {
			sawWarn = true
			assert.Equal(t, reqID, r["request_id"])
		}
	}
	assert.True(t, sawWarn, "expected WARN access log on 500: %s", logs.String())
}

func TestAccessLogRedaction(t *testing.T) {
	var logs bytes.Buffer
	e := newEnv(t, func(d *Deps) {
		d.Log = slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	})

	req := httptest.NewRequest(http.MethodGet, "/setup/status?code=secret-oidc-code&state=secret-state", nil)
	req.RemoteAddr = "198.51.100.10:12345"
	req.AddCookie(&http.Cookie{Name: "__Host-ferricade_session", Value: "secret-cookie-val"})
	req.Header.Set("X-CSRF", "secret-csrf-val")
	req.Header.Set("X-Setup-Token", "secret-setup-tok")
	req.Header.Set("Authorization", "Bearer secret-auth-tok")
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	raw := logs.String()
	require.NotEmpty(t, raw)
	for _, secret := range []string{
		"secret-oidc-code",
		"secret-state",
		"secret-cookie-val",
		"secret-csrf-val",
		"secret-setup-tok",
		"secret-auth-tok",
	} {
		assert.NotContains(t, raw, secret)
	}
}
