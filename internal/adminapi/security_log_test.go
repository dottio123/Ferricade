package adminapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSecurityLogsFailedSignInAndCSRF(t *testing.T) {
	var logs bytes.Buffer
	e := newEnv(t, func(d *Deps) {
		d.Log = slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelInfo}))
	})
	e.markSetupComplete()
	e.createUser("owner", userOpts{role: "owner"})
	c := e.client()

	// 1. Failed sign-in -> WARN without password.
	logs.Reset()
	const wrongPass = "super-secret-wrong-password-999"
	rec := c.do(http.MethodPost, apiPrefix+"/auth/login", map[string]string{
		"username": "owner",
		"password": wrongPass,
	})
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.NotContains(t, logs.String(), wrongPass)

	dec := json.NewDecoder(&logs)
	var sawLoginWarn bool
	for dec.More() {
		var r map[string]any
		require.NoError(t, dec.Decode(&r))
		if r["level"] == "WARN" && r["msg"] == "sign-in failed" {
			sawLoginWarn = true
			assert.Equal(t, "owner", r["user"])
			assert.Equal(t, "invalid_credentials", r["reason"])
			assert.NotEmpty(t, r["request_id"])
		}
	}
	assert.True(t, sawLoginWarn, "expected WARN sign-in failed log: %s", logs.String())

	// 2. Sign in, then send a bad CSRF token -> WARN without header value.
	require.Equal(t, http.StatusOK, c.login("owner", goodPassword).Code)
	logs.Reset()
	const badCSRF = "bad-csrf-secret-value-123"
	c.csrf = badCSRF
	rec = c.do(http.MethodPost, apiPrefix+"/groups", map[string]string{"name": "ops"})
	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.NotContains(t, logs.String(), badCSRF)

	dec = json.NewDecoder(&logs)
	var sawCSRFWarn bool
	for dec.More() {
		var r map[string]any
		require.NoError(t, dec.Decode(&r))
		if r["level"] == "WARN" && r["msg"] == "csrf rejected" {
			sawCSRFWarn = true
			assert.Equal(t, apiPrefix+"/groups", r["route"])
			assert.NotEmpty(t, r["ip"])
			assert.NotEmpty(t, r["request_id"])
		}
	}
	assert.True(t, sawCSRFWarn, "expected WARN csrf rejected log: %s", logs.String())
}

func TestRound1UnknownUsernameAndFloodableLevels(t *testing.T) {
	var logs bytes.Buffer
	e := newEnv(t, func(d *Deps) {
		d.Log = slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	})
	e.markSetupComplete()
	c := e.client()

	// 1. Unknown username must never appear in logs; user=(unknown).
	const typedGhost = "typed-secret-unknown-user"
	rec := c.do(http.MethodPost, apiPrefix+"/auth/login", map[string]string{
		"username": typedGhost,
		"password": "wrong",
	})
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.NotContains(t, logs.String(), typedGhost)

	dec := json.NewDecoder(&logs)
	var sawUnknown, saw401Debug bool
	for dec.More() {
		var r map[string]any
		require.NoError(t, dec.Decode(&r))
		if r["msg"] == "sign-in failed" {
			sawUnknown = true
			assert.Equal(t, "WARN", r["level"])
			assert.Equal(t, "(unknown)", r["user"])
		}
		if r["msg"] == "admin request" && r["status"] == float64(http.StatusUnauthorized) {
			saw401Debug = true
			assert.Equal(t, "DEBUG", r["level"])
		}
	}
	assert.True(t, sawUnknown, "expected sign-in failed log")
	assert.True(t, saw401Debug, "expected 401 admin request at DEBUG")

	// 2. Origin rejection without session cookie -> DEBUG, not WARN.
	logs.Reset()
	c.origin = "https://evil.example.com"
	rec = c.do(http.MethodPost, apiPrefix+"/auth/login", map[string]string{
		"username": "x",
		"password": "y",
	})
	require.Equal(t, http.StatusForbidden, rec.Code)
	dec = json.NewDecoder(&logs)
	var sawOriginDebug bool
	for dec.More() {
		var r map[string]any
		require.NoError(t, dec.Decode(&r))
		if r["msg"] == "origin rejected" {
			sawOriginDebug = true
			assert.Equal(t, "DEBUG", r["level"])
		}
	}
	assert.True(t, sawOriginDebug, "expected origin rejected at DEBUG without session cookie")

	// A forged cookie must not make an unauthenticated origin rejection look actionable.
	logs.Reset()
	cookie := sessionCookieName(c.e.d.Cfg) + "=forged-session"
	_, rec = c.send(http.MethodPost, apiPrefix+"/auth/login", map[string]string{"username": "x", "password": "y"}, http.Header{"Cookie": {cookie}})
	require.Equal(t, http.StatusForbidden, rec.Code)
	dec = json.NewDecoder(&logs)
	var sawForgedOriginDebug bool
	for dec.More() {
		var r map[string]any
		require.NoError(t, dec.Decode(&r))
		if r["msg"] == "origin rejected" {
			sawForgedOriginDebug = true
			assert.Equal(t, "DEBUG", r["level"])
		}
	}
	assert.True(t, sawForgedOriginDebug, "expected forged-cookie origin rejection at DEBUG")

	// 3. 404 -> DEBUG.
	logs.Reset()
	c.origin = ""
	_, rec = c.send(http.MethodGet, apiPrefix+"/no-such-route", nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
	dec = json.NewDecoder(&logs)
	var saw404Debug bool
	for dec.More() {
		var r map[string]any
		require.NoError(t, dec.Decode(&r))
		if r["msg"] == "admin request" && r["status"] == float64(http.StatusNotFound) {
			saw404Debug = true
			assert.Equal(t, "DEBUG", r["level"])
		}
	}
	assert.True(t, saw404Debug, "expected 404 admin request at DEBUG")
}
