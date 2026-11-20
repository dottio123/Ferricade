package adminapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/connect"
	"github.com/dottio123/ferricade/internal/store/db"
)

var ownerBody = map[string]string{
	"username": "alice", "password": goodPassword, "display_name": "Alice", "email": "alice@example.com",
}

func TestSetupTokenRequired(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	requireError(t, c.do(http.MethodPost, "/setup/owner", ownerBody), http.StatusUnauthorized, "unauthenticated")
	rec := c.do(http.MethodPost, "/setup/owner", ownerBody, http.Header{"X-Setup-Token": {"wrong"}})
	requireError(t, rec, http.StatusUnauthorized, "unauthenticated")
	rec = c.do(http.MethodPost, "/setup/owner", ownerBody, http.Header{"X-Setup-Token": {e.setupToken + "x"}})
	requireError(t, rec, http.StatusUnauthorized, "unauthenticated")
	require.Empty(t, e.auditEntries(""), "nothing happened")

	require.Equal(t, http.StatusCreated, c.setup("/owner", ownerBody).Code)
}

func TestSetupTokenExpires(t *testing.T) {
	e := newEnv(t)
	e.clock.Add(24 * time.Hour)
	requireError(t, e.client().setup("/owner", ownerBody), http.StatusUnauthorized, "unauthenticated")
}

func TestSetupRequiresOrigin(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	c.origin = "https://evil.example.com"
	requireError(t, c.setup("/owner", ownerBody), http.StatusForbidden, "csrf")
	c.origin = "-"
	requireError(t, c.setup("/owner", ownerBody), http.StatusForbidden, "csrf")
}

func TestSetupFlow(t *testing.T) {
	e := newEnv(t)
	c := e.client()

	rec := c.setup("/owner", ownerBody)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.NotEmpty(t, decodeBody(t, rec)["id"])

	rec = c.setup("/owner/totp", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	body := decodeBody(t, rec)
	secret := body["secret"].(string)
	require.True(t, strings.HasPrefix(body["otpauth_url"].(string), "otpauth://totp/ferricade:alice?"))

	requireError(t, c.setup("/owner/totp/verify", map[string]string{"code": wrongCode(e, secret)}), http.StatusBadRequest, "invalid_code")
	rec = c.setup("/owner/totp/verify", map[string]string{"code": e.totpCode(secret)})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	requireError(t, c.setup("/owner/totp/verify", map[string]string{"code": e.totpCode(secret)}),
		http.StatusBadRequest, "code_already_used")

	rec = c.setup("/server", map[string]string{
		"name": "lab", "id_host": "rd.example.com", "relay_host": "relay.example.com", "public_key": validKey,
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	body = decodeBody(t, rec)
	require.Equal(t, true, body["saved"])
	require.NotEmpty(t, body["server_id"])
	checks := body["checks"].([]any)
	require.Len(t, checks, 3, "no HBBS_ADDR, so no online query")
	require.Equal(t, map[string]any{"name": "id-server", "ok": true, "detail": "", "target": "rd.example.com:21116", "address": "pipe", "reason": nil}, checks[0])
	require.Equal(t, map[string]any{"name": "client-api", "ok": true, "detail": "", "target": "rd.example.com:21114", "address": "pipe", "reason": nil}, checks[2])
	require.Equal(t, int32(3), e.dials.Load())

	rec = c.setup("/complete", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	cc := decodeBody(t, rec)["client_config"].(map[string]any)
	cfg, err := connect.DecodeConfigString(cc["config_string"].(string))
	require.NoError(t, err)
	require.Equal(t, connect.ClientConfig{
		Host: "rd.example.com", Relay: "relay.example.com", API: "http://rd.example.com:21114", Key: validKey,
	}, cfg)
	require.Equal(t, "rustdesk://config/"+cc["config_string"].(string), cc["deep_link"])
	require.Equal(t, "rd.example.com", cc["host"])
	require.Equal(t, "relay.example.com", cc["relay"])
	require.Equal(t, "http://rd.example.com:21114", cc["api"])
	require.Equal(t, validKey, cc["key"])
	install := cc["install"].(map[string]any)
	for _, osName := range []string{"windows", "macos", "linux"} {
		require.Contains(t, install[osName], cc["config_string"], osName)
	}

	for _, path := range []string{"/owner", "/owner/totp", "/owner/totp/verify", "/server", "/complete"} {
		requireError(t, c.setup(path, ownerBody), http.StatusNotFound, "not_found")
	}
	requireError(t, c.doOutsideContract(http.MethodPost, "/setup/nope", http.Header{"X-Setup-Token": {e.setupToken}}),
		http.StatusNotFound, "not_found")

	for _, action := range []string{"setup.owner_created", "auth.totp_enrolled", "setup.server_saved", "setup.completed"} {
		require.Len(t, e.auditEntries(action), 1, action)
	}

	// The owner can now sign in; the same client config is served to them.
	user := e.client()
	rec = user.login("alice", goodPassword)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, true, decodeBody(t, rec)["mfa_required"])
	// Within the same 30 s the setup code's step is used: refused, not counted.
	requireError(t, user.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": e.totpCode(secret)}),
		http.StatusBadRequest, "code_already_used")
	e.clock.Add(30 * time.Second)
	rec = user.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": e.totpCode(secret)})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	user.csrf = decodeBody(t, rec)["csrf_token"].(string)
	rec = user.do(http.MethodGet, apiPrefix+"/server/client-config", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, cc, decodeBody(t, rec))
}

func TestSetupRejectsWeakPassword(t *testing.T) {
	e := newEnv(t)
	body := map[string]string{"username": "alice", "password": "password1234"}
	requireError(t, e.client().setup("/owner", body), http.StatusBadRequest, "weak_password")
	body = map[string]string{"username": "has space", "password": goodPassword}
	requireError(t, e.client().setup("/owner", body), http.StatusBadRequest, "bad_request")
	requireError(t, e.client().setup("/owner", map[string]any{"username": 7}), http.StatusBadRequest, "bad_request")
	requireError(t, e.client().setup("/owner", map[string]any{"username": "a", "extra": 1}), http.StatusBadRequest, "bad_request")
}

func TestSetupCompleteNeedsTOTP(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	requireError(t, c.setup("/complete", nil), http.StatusConflict, "incomplete")
	requireError(t, c.setup("/owner/totp", nil), http.StatusConflict, "incomplete")
	require.Equal(t, http.StatusCreated, c.setup("/owner", ownerBody).Code)
	require.Equal(t, http.StatusOK, c.setup("/owner/totp", nil).Code)
	rec := c.setup("/server", map[string]string{"id_host": "rd.example.com", "relay_host": "rd.example.com", "public_key": validKey})
	require.Equal(t, http.StatusOK, rec.Code)
	requireError(t, c.setup("/complete", nil), http.StatusConflict, "incomplete")
	done, err := e.d.Setup.Complete(context.Background())
	require.NoError(t, err)
	require.False(t, done)
}

func TestSetupServerRejectsBadKey(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	body := map[string]string{"name": "lab", "id_host": "rd.example.com", "relay_host": "rd.example.com", "public_key": "abc"}
	requireError(t, c.setup("/server", body), http.StatusBadRequest, "invalid_key")

	body["public_key"] = validKey
	for _, field := range []string{"id_host", "relay_host"} {
		bad := map[string]string{}
		for k, v := range body {
			bad[k] = v
		}
		bad[field] = "  "
		requireError(t, c.setup("/server", bad), http.StatusBadRequest, "bad_request")
	}
	require.Zero(t, e.dials.Load(), "no checks run for rejected input")
	_, err := db.New(e.d.Pool).GetServer(context.Background())
	require.Error(t, err, "nothing saved")
}

func TestSetupServerSavesWhenChecksFail(t *testing.T) {
	e := newEnv(t, func(d *Deps) {
		d.Dial = func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("connection refused") }
	})
	rec := e.client().setup("/server", map[string]string{"id_host": "rd.example.com", "relay_host": "rd.example.com", "public_key": validKey})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	body := decodeBody(t, rec)
	require.Equal(t, true, body["saved"])
	for _, c := range body["checks"].([]any) {
		require.Equal(t, false, c.(map[string]any)["ok"])
		require.Equal(t, "connection refused", c.(map[string]any)["detail"])
		require.Equal(t, "", c.(map[string]any)["address"])
		require.Equal(t, "other", c.(map[string]any)["reason"])
	}
}

func TestClientConfigNeedsSetup(t *testing.T) {
	e := newEnv(t)
	e.createUser("bob", userOpts{})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	requireError(t, c.do(http.MethodGet, apiPrefix+"/server/client-config", nil), http.StatusNotFound, "not_found")
}
