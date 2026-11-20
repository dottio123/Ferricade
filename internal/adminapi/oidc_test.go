package adminapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/stretchr/testify/require"
)

func TestOIDCSettingsOwnerAccess(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	e.createUser("owner", userOpts{role: "owner"})
	e.createUser("admin", userOpts{role: "admin"})
	owner := e.client()
	require.Equal(t, http.StatusOK, owner.login("owner", goodPassword).Code)
	admin := e.client()
	require.Equal(t, http.StatusOK, admin.login("admin", goodPassword).Code)
	for _, path := range []string{"/settings/oidc", "/settings/oidc/test"} {
		method := http.MethodGet
		if path == "/settings/oidc/test" {
			method = http.MethodPost
		}
		requireError(t, admin.do(method, apiPrefix+path, nil), http.StatusForbidden, "forbidden")
	}
	requireError(t, admin.do(http.MethodPatch, apiPrefix+"/settings/oidc", map[string]any{"enabled": false}), http.StatusForbidden, "forbidden")
	got := owner.ok(http.MethodGet, apiPrefix+"/settings/oidc", nil)
	require.Equal(t, false, got["enabled"])
	require.Equal(t, publicURL+apiPrefix+"/auth/oidc/callback", got["redirect_uri"])
}

func TestOIDCUserGroupsSettings(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	e.createUser("owner", userOpts{role: "owner"})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("owner", goodPassword).Code)
	path := apiPrefix + "/settings/oidc"
	require.Equal(t, []any{}, c.ok(http.MethodGet, path, nil)["user_groups"])
	saved := c.ok(http.MethodPatch, path, map[string]any{"issuer": "https://idp.example", "client_id": "client", "client_secret": "secret", "user_groups": []string{"viewers"}, "enabled": true})
	require.Equal(t, []any{"viewers"}, saved["user_groups"])
	require.Equal(t, []any{"viewers"}, c.ok(http.MethodGet, path, nil)["user_groups"])
	require.Contains(t, e.auditEntries("settings.oidc_updated")[0].Details["changed"], "user_groups")
	requireError(t, c.do(http.MethodPatch, path, map[string]any{"user_groups": []string{""}}), http.StatusBadRequest, "bad_request")
}

func TestOIDCSettingsSaveTestAndSecret(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"issuer":"` + "http://" + r.Host + `","authorization_endpoint":"http://localhost/auth","token_endpoint":"http://localhost/token","scopes_supported":["groups"]}`))
	}))
	defer provider.Close()
	e := newEnv(t)
	e.markSetupComplete()
	e.createUser("owner", userOpts{role: "owner"})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("owner", goodPassword).Code)
	requireError(t, c.do(http.MethodPost, apiPrefix+"/settings/oidc/test", nil), http.StatusBadRequest, "bad_request")
	secret := "a-very-private-client-secret"
	settings := c.ok(http.MethodPatch, apiPrefix+"/settings/oidc", map[string]any{"issuer": provider.URL, "client_id": "client", "client_secret": secret, "owner_groups": []string{"owners"}, "enabled": true})
	require.Equal(t, true, settings["client_secret_set"])
	require.NotContains(t, c.do(http.MethodGet, apiPrefix+"/settings/oidc", nil).Body.String(), secret)
	result := c.ok(http.MethodPost, apiPrefix+"/settings/oidc/test", nil)
	require.Equal(t, true, result["ok"])
	require.Equal(t, true, result["groups_scope_supported"])
	settings = c.ok(http.MethodGet, apiPrefix+"/settings/oidc", nil)
	require.NotNil(t, settings["last_test"])
	require.NotContains(t, c.do(http.MethodPatch, apiPrefix+"/settings/oidc", map[string]any{"display_name": "SSO"}).Body.String(), secret)
	for _, entry := range e.auditEntries("settings.oidc_updated") {
		raw, err := json.Marshal(entry.Details)
		require.NoError(t, err)
		require.NotContains(t, string(raw), secret)
	}
}

func TestOIDCAvatarAndUnlink(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	e.createUser("owner", userOpts{role: "owner"})
	target := e.createUser("target", userOpts{role: "admin"})
	owner := e.client()
	require.Equal(t, http.StatusOK, owner.login("owner", goodPassword).Code)
	other := e.client()
	require.Equal(t, http.StatusOK, other.login("target", goodPassword).Code)
	path := apiPrefix + "/users/" + target.String()
	requireError(t, owner.do(http.MethodGet, path+"/avatar", nil), http.StatusNotFound, "not_found")
	issuer, subject, typ := "https://idp.example.com", "sub", "image/png"
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE users SET oidc_issuer=$2, oidc_subject=$3, avatar=$4, avatar_type=$5, avatar_updated_at=to_timestamp(1234567890) WHERE id=$1`, target, issuer, subject, []byte("png"), typ)
	require.NoError(t, err)
	avatar := owner.do(http.MethodGet, path+"/avatar", nil)
	require.Equal(t, http.StatusOK, avatar.Code)
	require.Equal(t, "image/png", avatar.Header().Get("Content-Type"))
	require.Equal(t, "private, max-age=300", avatar.Header().Get("Cache-Control"))
	require.Equal(t, "nosniff", avatar.Header().Get("X-Content-Type-Options"))
	require.Equal(t, "png", avatar.Body.String())
	me := other.ok(http.MethodGet, apiPrefix+"/auth/me", nil)["user"].(map[string]any)
	require.Equal(t, true, me["sso"])
	require.Equal(t, path+"/avatar?v=1234567890", me["avatar_url"])
	users := owner.ok(http.MethodGet, apiPrefix+"/users", nil)["items"].([]any)
	found := false
	for _, v := range users {
		u := v.(map[string]any)
		if u["id"] == target.String() {
			found = true
			require.Equal(t, true, u["sso"])
			require.Equal(t, me["avatar_url"], u["avatar_url"])
		}
	}
	require.True(t, found)
	requireError(t, other.do(http.MethodDelete, path+"/oidc", nil), http.StatusForbidden, "forbidden")
	unlinked := owner.ok(http.MethodDelete, path+"/oidc", nil)
	require.Equal(t, false, unlinked["sso"])
	require.Equal(t, 1, len(e.auditEntries("user.oidc_unlinked")))
	requireError(t, other.do(http.MethodGet, apiPrefix+"/settings/dashboard", nil), http.StatusUnauthorized, "unauthenticated")
	require.Equal(t, false, owner.ok(http.MethodDelete, path+"/oidc", nil)["sso"])
	require.Equal(t, 1, len(e.auditEntries("user.oidc_unlinked")))
	passwordless := e.createUser("passwordless", userOpts{})
	_, err = e.d.Pool.Exec(context.Background(), `UPDATE users SET password_hash=NULL, oidc_issuer=$2, oidc_subject=$3 WHERE id=$1`, passwordless, issuer, "other")
	require.NoError(t, err)
	requireError(t, owner.do(http.MethodDelete, apiPrefix+"/users/"+passwordless.String()+"/oidc", nil), http.StatusConflict, "no_password")
	login := e.client().login("passwordless", goodPassword)
	requireError(t, login, http.StatusUnauthorized, "unauthenticated")
	require.True(t, strings.Contains(login.Body.String(), "invalid username or password"))
	requireError(t, owner.do(http.MethodDelete, apiPrefix+"/users/"+uuid.NewString()+"/oidc", nil), http.StatusNotFound, "not_found")
}
