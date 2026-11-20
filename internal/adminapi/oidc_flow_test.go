package adminapi

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/oidc"
	"github.com/dottio123/ferricade/internal/oidc/oidctest"
)

func TestOIDCUserRoleTransitions(t *testing.T) {
	fake := oidctest.New()
	defer fake.Close()
	fake.Claims["groups"] = "viewers"
	e := newEnv(t, func(d *Deps) { d.OIDCClient = fake.Server.Client() })
	fake.Now = e.clock.Now
	e.markSetupComplete()
	e.createUser("owner", userOpts{role: "owner"})
	owner := e.client()
	require.Equal(t, http.StatusOK, owner.login("owner", goodPassword).Code)
	owner.ok(http.MethodPatch, apiPrefix+"/settings/oidc", map[string]any{
		"enabled": true, "issuer": fake.URL(), "client_id": "test-client", "client_secret": "test-secret",
		"user_groups": []string{"viewers"}, "admin_groups": []string{"admins"}, "jit_enabled": true,
	})
	signIn := func() *client {
		t.Helper()
		start := e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/start", nil)
		require.Equal(t, http.StatusFound, start.Code)
		resp, err := (&http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}).Get(start.Header().Get("Location"))
		require.NoError(t, err)
		resp.Body.Close()
		loc, err := url.Parse(resp.Header.Get("Location"))
		require.NoError(t, err)
		req := httptest.NewRequest(http.MethodGet, loc.RequestURI(), nil)
		req.AddCookie(start.Result().Cookies()[0])
		rec := httptest.NewRecorder()
		e.h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		for _, cookie := range rec.Result().Cookies() {
			if cookie.Name == sessionCookieName(e.d.Cfg) {
				c := e.client()
				c.cookie = cookie
				return c
			}
		}
		t.Fatal("missing session cookie")
		return nil
	}
	first := signIn()
	user := first.ok(http.MethodGet, apiPrefix+"/auth/me", nil)["user"].(map[string]any)
	require.Equal(t, "user", user["role"])
	id := user["id"].(string)
	var count int
	require.NoError(t, e.d.Pool.QueryRow(t.Context(), "SELECT count(*) FROM user_grants WHERE user_id=$1", id).Scan(&count))
	require.Zero(t, count)
	second := signIn()
	group := owner.ok(http.MethodPost, apiPrefix+"/groups", map[string]any{"name": "Granted"})["id"].(string)
	owner.ok(http.MethodPut, apiPrefix+"/users/"+id+"/grants", map[string]any{"group_ids": []string{group}, "device_ids": []string{}})
	conn, err := e.d.Pool.Acquire(t.Context())
	require.NoError(t, err)
	defer conn.Release()
	_, err = conn.Exec(t.Context(), "LISTEN ferricade_events")
	require.NoError(t, err)
	waitGrants := func() {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		for {
			n, err := conn.Conn().WaitForNotification(ctx)
			require.NoError(t, err)
			var payload map[string]any
			require.NoError(t, json.Unmarshal([]byte(n.Payload), &payload))
			if payload["kind"] == "grants" && payload["user_id"] == id {
				return
			}
		}
	}
	fake.Claims["groups"] = "admins"
	admin := signIn()
	require.Equal(t, "admin", admin.ok(http.MethodGet, apiPrefix+"/auth/me", nil)["user"].(map[string]any)["role"])
	waitGrants()
	require.NoError(t, e.d.Pool.QueryRow(t.Context(), "SELECT count(*) FROM user_grants WHERE user_id=$1", id).Scan(&count))
	require.Zero(t, count)
	requireError(t, first.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
	requireError(t, second.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
	fake.Claims["groups"] = "viewers"
	userAgain := signIn()
	require.Equal(t, "user", userAgain.ok(http.MethodGet, apiPrefix+"/auth/me", nil)["user"].(map[string]any)["role"])
	waitGrants()
	requireError(t, admin.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
	require.Len(t, e.auditEntries("user.updated"), 2)
}

func TestOIDCExistingEmailFillIsAuditedAndNeverOverwrites(t *testing.T) {
	fake := oidctest.New()
	defer fake.Close()
	fake.Claims["groups"] = "admins"
	fake.Claims["email"] = "entra@example.com"
	var logs bytes.Buffer
	e := newEnv(t, func(d *Deps) {
		d.OIDCClient = fake.Server.Client()
		d.Log = slog.New(slog.NewTextHandler(&logs, nil))
	})
	fake.Now = e.clock.Now
	e.markSetupComplete()
	e.createUser("owner", userOpts{role: "owner"})
	id := e.createUser("sso", userOpts{role: "admin"})
	_, err := e.d.Pool.Exec(t.Context(), "UPDATE users SET email='', oidc_issuer=$1, oidc_subject='sub-1' WHERE id=$2", fake.URL(), id)
	require.NoError(t, err)
	owner := e.client()
	require.Equal(t, http.StatusOK, owner.login("owner", goodPassword).Code)
	owner.ok(http.MethodPatch, apiPrefix+"/settings/oidc", map[string]any{
		"enabled": true, "issuer": fake.URL(), "client_id": "test-client", "client_secret": "test-secret",
		"admin_groups": []string{"admins"},
	})
	signIn := func() {
		t.Helper()
		start := e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/start", nil)
		require.Equal(t, http.StatusFound, start.Code)
		resp, err := (&http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}).Get(start.Header().Get("Location"))
		require.NoError(t, err)
		resp.Body.Close()
		loc, err := url.Parse(resp.Header.Get("Location"))
		require.NoError(t, err)
		req := httptest.NewRequest(http.MethodGet, loc.RequestURI(), nil)
		req.AddCookie(start.Result().Cookies()[0])
		rec := httptest.NewRecorder()
		e.h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		require.NotContains(t, rec.Body.String(), "test-access")
	}
	signIn()
	var email string
	var unverified bool
	require.NoError(t, e.d.Pool.QueryRow(t.Context(), "SELECT email, email_unverified FROM users WHERE id=$1", id).Scan(&email, &unverified))
	require.Equal(t, "entra@example.com", email)
	require.True(t, unverified)
	updates := e.auditEntries("user.updated")
	require.Len(t, updates, 1)
	require.Equal(t, map[string]any{"from": "", "to": "entra@example.com"}, updates[0].Details["email"])
	require.Equal(t, "oidc", updates[0].Details["via"])
	fake.Claims["email"] = "different@example.com"
	signIn()
	require.NoError(t, e.d.Pool.QueryRow(t.Context(), "SELECT email FROM users WHERE id=$1", id).Scan(&email))
	require.Equal(t, "entra@example.com", email)
	require.Len(t, e.auditEntries("user.updated"), 1)
	require.NotContains(t, logs.String(), "test-access")
	for _, action := range []string{"user.updated", "auth.login"} {
		for _, entry := range e.auditEntries(action) {
			encoded, err := json.Marshal(entry.Details)
			require.NoError(t, err)
			require.NotContains(t, string(encoded), "test-access")
		}
	}
}

func TestOIDCFlowJITAndState(t *testing.T) {
	fake := oidctest.New()
	defer fake.Close()
	fake.Claims["email"] = "kilgore@kilgore.trout"
	fake.Claims["email_verified"] = true
	fake.Claims["name"] = "Kilgore Trout"
	fake.Claims["groups"] = "authors"
	fake.Photo = append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, make([]byte, 32)...)
	fake.Claims["picture"] = fake.URL() + "/photo?secret=private-query"
	var logs bytes.Buffer
	e := newEnv(t, func(d *Deps) {
		d.OIDCClient = fake.Server.Client()
		d.Cfg.DevInsecure = true
		d.Log = slog.New(slog.NewTextHandler(&logs, nil))
	})
	fake.Now = e.clock.Now
	e.markSetupComplete()
	e.createUser("original-owner", userOpts{role: "owner"})
	owner := e.client()
	require.Equal(t, http.StatusOK, owner.login("original-owner", goodPassword).Code)
	owner.ok(http.MethodPatch, apiPrefix+"/settings/oidc", map[string]any{
		"enabled": true, "issuer": fake.URL(), "client_id": "test-client", "client_secret": "test-secret",
		"owner_groups": []string{"authors"}, "jit_enabled": true,
	})
	public := owner.ok(http.MethodGet, apiPrefix+"/auth/oidc", nil)
	require.Equal(t, true, public["enabled"])
	first := e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/start?next=%2Fdevices", nil)
	require.Equal(t, http.StatusFound, first.Code)
	second := e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/start?next=%2Fdevices", nil)
	require.Equal(t, http.StatusFound, second.Code)
	firstURL, err := url.Parse(first.Header().Get("Location"))
	require.NoError(t, err)
	callback := apiPrefix + "/auth/oidc/callback?code=test-code&state=" + url.QueryEscape(firstURL.Query().Get("state"))
	req := httptest.NewRequest(http.MethodGet, callback, nil)
	req.AddCookie(second.Result().Cookies()[0])
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	require.Equal(t, "/sign-in?sso_error=expired", rec.Header().Get("Location"))

	authResp, err := (&http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}).Get(second.Header().Get("Location"))
	require.NoError(t, err)
	authResp.Body.Close()
	loc, err := url.Parse(authResp.Header.Get("Location"))
	require.NoError(t, err)
	req = httptest.NewRequest(http.MethodGet, loc.RequestURI(), nil)
	req.AddCookie(second.Result().Cookies()[0])
	rec = httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `<meta http-equiv="refresh"`)
	require.NotContains(t, rec.Body.String(), "<script")
	require.Contains(t, rec.Body.String(), "url=/devices")
	var oidcCookie *http.Cookie
	for _, ck := range rec.Result().Cookies() {
		if ck.Name == sessionCookieName(e.d.Cfg) {
			oidcCookie = ck
			c := e.client()
			c.cookie = ck
			me := c.ok(http.MethodGet, apiPrefix+"/auth/me", nil)
			require.Equal(t, true, me["mfa_passed"])
			require.Equal(t, "owner", me["user"].(map[string]any)["role"])
			avatar := c.do(http.MethodGet, apiPrefix+"/users/"+me["user"].(map[string]any)["id"].(string)+"/avatar", nil)
			require.Equal(t, http.StatusOK, avatar.Code)
			require.Equal(t, fake.Photo, avatar.Body.Bytes())
		}
	}
	require.NotNil(t, oidcCookie)
	for _, raw := range []string{first.Body.String(), second.Body.String(), rec.Body.String(), logs.String()} {
		for _, secret := range []string{"test-secret", "test-code", "private-query", "test-access"} {
			require.NotContains(t, raw, secret)
		}
	}
	require.Len(t, e.auditEntries("user.created"), 1)
	require.Equal(t, fake.URL(), e.auditEntries("user.created")[0].Details["issuer"])
	require.Equal(t, "sub-1", e.auditEntries("user.created")[0].Details["sub"])
	require.Equal(t, "kilgore@kilgore.trout", e.auditEntries("user.created")[0].Details["email"])
	require.Len(t, e.auditEntries("auth.login"), 2)
	require.Equal(t, fake.URL(), e.auditEntries("auth.login")[0].Details["issuer"])
	owner.ok(http.MethodPatch, apiPrefix+"/settings/oidc", map[string]any{"owner_groups": []string{"nobody"}, "admin_groups": []string{"nobody"}})
	third := e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/start", nil)
	thirdAuth, err := (&http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}).Get(third.Header().Get("Location"))
	require.NoError(t, err)
	thirdAuth.Body.Close()
	thirdURL, err := url.Parse(thirdAuth.Header.Get("Location"))
	require.NoError(t, err)
	req = httptest.NewRequest(http.MethodGet, thirdURL.RequestURI(), nil)
	req.AddCookie(third.Result().Cookies()[0])
	rec = httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	require.Equal(t, "/sign-in?sso_error=not_allowed", rec.Header().Get("Location"))
	c := e.client()
	c.cookie = oidcCookie
	requireError(t, c.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
	failures := e.auditEntries("auth.login_failed")
	require.NotEmpty(t, failures)
	require.Equal(t, "no_mapped_group", failures[0].Details["reason"])
}

func TestOIDCSafeNext(t *testing.T) {
	for raw, want := range map[string]string{
		"/devices?state=approved#top": "/devices?state=approved#top",
		"https://evil.example":        "/",
		"//evil.example":              "/",
		"/\\evil.example":             "/",
		"/devices\n//evil.example":    "/",
		"/a/..//evil.example":         "/",
		"/sign-in":                    "/",
		"/sign-in/totp":               "/",
		"/enroll-totp":                "/",
		"/first-run":                  "/",
		"/admin/api/v1/auth/me":       "/",
		"/api/heartbeat":              "/",
		"/healthz":                    "/",
		"/setup/status":               "/",
		"/%09/x":                      "/",
		"/%0a/x":                      "/",
		"/%0D/x":                      "/",
		"/%7f/x":                      "/",
		"/a/%09/..//x":                "/",
	} {
		t.Run(raw, func(t *testing.T) { require.Equal(t, want, safeOIDCNext(raw)) })
	}
}

func TestOIDCFlowProviderFailures(t *testing.T) {
	fake := oidctest.New()
	defer fake.Close()
	e := newEnv(t, func(d *Deps) { d.OIDCClient = fake.Server.Client() })
	fake.Now = e.clock.Now
	e.markSetupComplete()
	e.createUser("owner", userOpts{role: "owner"})
	owner := e.client()
	require.Equal(t, http.StatusOK, owner.login("owner", goodPassword).Code)
	owner.ok(http.MethodPatch, apiPrefix+"/settings/oidc", map[string]any{
		"enabled": true, "issuer": fake.URL(), "client_id": "test-client", "client_secret": "test-secret",
		"owner_groups": []string{"authors"}, "jit_enabled": true,
	})
	callback := func(t *testing.T) *httptest.ResponseRecorder {
		t.Helper()
		start := e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/start", nil)
		require.Equal(t, http.StatusFound, start.Code)
		resp, err := (&http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}).Get(start.Header().Get("Location"))
		require.NoError(t, err)
		resp.Body.Close()
		loc, err := url.Parse(resp.Header.Get("Location"))
		require.NoError(t, err)
		req := httptest.NewRequest(http.MethodGet, loc.RequestURI(), nil)
		req.AddCookie(start.Result().Cookies()[0])
		rec := httptest.NewRecorder()
		e.h.ServeHTTP(rec, req)
		return rec
	}
	for _, tc := range []struct {
		name   string
		change func()
	}{
		{"nonce", func() { fake.Claims["nonce"] = "wrong" }},
		{"signature", func() { fake.BadSignature = true }},
		{"audience", func() { fake.Claims["aud"] = "wrong" }},
		{"issuer", func() { fake.Claims["iss"] = "https://wrong.example" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake.Claims = map[string]any{"groups": "authors"}
			fake.BadSignature = false
			tc.change()
			rec := callback(t)
			require.Equal(t, http.StatusFound, rec.Code)
			require.Equal(t, "/sign-in?sso_error=provider_error", rec.Header().Get("Location"))
			require.NotContains(t, rec.Body.String(), "test-code")
		})
	}
	fake.Claims = map[string]any{}
	rec := callback(t)
	require.Equal(t, "/sign-in?sso_error=not_allowed", rec.Header().Get("Location"))
	require.Equal(t, "no_groups_claim", e.auditEntries("auth.login_failed")[0].Details["reason"])
	missing := httptest.NewRecorder()
	before := len(e.auditEntries("auth.login_failed"))
	e.h.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, apiPrefix+"/auth/oidc/callback?code=test-code&state=none", nil))
	require.Equal(t, "/sign-in?sso_error=expired", missing.Header().Get("Location"))
	require.Len(t, e.auditEntries("auth.login_failed"), before)
}

func TestOIDCStartOffAndRateLimited(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	start := e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/start", nil)
	require.Equal(t, "/sign-in?sso_error=provider_error", start.Header().Get("Location"))
	before := len(e.auditEntries("auth.login_failed"))
	for i := 0; i < 19; i++ {
		rec := e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/callback", nil)
		require.Equal(t, "/sign-in?sso_error=provider_error", rec.Header().Get("Location"))
	}
	require.Len(t, e.auditEntries("auth.login_failed"), before)
	for i := 0; i < 50; i++ {
		rec := e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/callback", nil)
		require.Equal(t, "/sign-in?sso_error=rate_limited", rec.Header().Get("Location"))
	}
	require.Len(t, e.auditEntries("auth.login_failed"), before)
	start = e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/start", nil)
	require.Equal(t, "/sign-in?sso_error=rate_limited", start.Header().Get("Location"))
}

func TestOIDCCallbackWithoutFlowDoesNotAudit(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	before := len(e.auditEntries("auth.login_failed"))
	rec := e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/callback", nil)
	require.Equal(t, http.StatusFound, rec.Code)
	require.Equal(t, "/sign-in?sso_error=provider_error", rec.Header().Get("Location"))
	require.Len(t, e.auditEntries("auth.login_failed"), before)
}

func TestOIDCRefusalRevokesOnlyMatchingIdentity(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	id := e.createUser("owner", userOpts{role: "owner"})
	a := &api{d: e.d}
	for _, tc := range []struct {
		name         string
		matched      bool
		code, reason string
		revoked      bool
	}{
		{"email-only not allowed", false, "not_allowed", "no_mapped_group", false},
		{"email-only disabled", false, "disabled", "disabled", false},
		{"last owner", true, "not_allowed", "last_owner", false},
		{"matched disabled", true, "disabled", "disabled", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := e.client()
			require.Equal(t, http.StatusOK, c.login("owner", goodPassword).Code)
			rec := httptest.NewRecorder()
			a.oidcFail(rec, httptest.NewRequest(http.MethodGet, "/", nil), netip.MustParseAddr("192.0.2.1"),
				&oidc.Outcome{UserID: id, MatchedByOIDC: tc.matched}, oidc.Claims{Subject: "other"}, tc.code, tc.reason)
			require.Equal(t, "/sign-in?sso_error="+tc.code, rec.Header().Get("Location"))
			me := c.do(http.MethodGet, apiPrefix+"/auth/me", nil)
			if tc.revoked {
				requireError(t, me, http.StatusUnauthorized, "unauthenticated")
			} else {
				require.Equal(t, http.StatusOK, me.Code)
			}
		})
	}
}

func TestOIDCRechecksStoredIssuerAndLogsExchangeClass(t *testing.T) {
	fake := oidctest.New()
	defer fake.Close()
	var logs bytes.Buffer
	e := newEnv(t, func(d *Deps) {
		d.OIDCClient = fake.Server.Client()
		d.Log = slog.New(slog.NewTextHandler(&logs, nil))
	})
	e.markSetupComplete()
	e.createUser("owner", userOpts{role: "owner"})
	owner := e.client()
	require.Equal(t, http.StatusOK, owner.login("owner", goodPassword).Code)
	owner.ok(http.MethodPatch, apiPrefix+"/settings/oidc", map[string]any{
		"enabled": true, "issuer": fake.URL(), "client_id": "test-client", "client_secret": "test-secret",
		"owner_groups": []string{"authors"},
	})
	start := e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/start", nil)
	require.Equal(t, http.StatusFound, start.Code)
	authURL, err := url.Parse(start.Header().Get("Location"))
	require.NoError(t, err)
	callback := func(code string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, apiPrefix+"/auth/oidc/callback?state="+authURL.Query().Get("state")+"&code="+code, nil)
		req.AddCookie(start.Result().Cookies()[0])
		rec := httptest.NewRecorder()
		e.h.ServeHTTP(rec, req)
		return rec
	}
	require.Equal(t, "/sign-in?sso_error=provider_error", callback("bad-code").Header().Get("Location"))
	require.Contains(t, logs.String(), "class=exchange")
	require.Contains(t, logs.String(), "request_id=")
	require.NotContains(t, logs.String(), "bad-code")
	_, err = e.d.Pool.Exec(t.Context(), "UPDATE oidc_settings SET issuer='http://evil.example'")
	require.NoError(t, err)
	require.Equal(t, "/sign-in?sso_error=provider_error", callback("test-code").Header().Get("Location"))
	start = e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/start", nil)
	require.Equal(t, "/sign-in?sso_error=provider_error", start.Header().Get("Location"))
}

func TestOIDCLinkAuditRecordsIdentity(t *testing.T) {
	fake := oidctest.New()
	defer fake.Close()
	fake.Claims["email"] = "linked@example.com"
	fake.Claims["email_verified"] = true
	fake.Claims["groups"] = "authors"
	e := newEnv(t, func(d *Deps) { d.OIDCClient = fake.Server.Client() })
	fake.Now = e.clock.Now
	e.markSetupComplete()
	id := e.createUser("owner", userOpts{role: "owner"})
	_, err := e.d.Pool.Exec(t.Context(), "UPDATE users SET email='linked@example.com' WHERE id=$1", id)
	require.NoError(t, err)
	owner := e.client()
	require.Equal(t, http.StatusOK, owner.login("owner", goodPassword).Code)
	owner.ok(http.MethodPatch, apiPrefix+"/settings/oidc", map[string]any{
		"enabled": true, "issuer": fake.URL(), "client_id": "test-client", "client_secret": "test-secret",
		"owner_groups": []string{"authors"}, "jit_enabled": false,
	})
	start := e.client().do(http.MethodGet, apiPrefix+"/auth/oidc/start", nil)
	require.Equal(t, http.StatusFound, start.Code)
	providerResponse, err := (&http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}).Get(start.Header().Get("Location"))
	require.NoError(t, err)
	providerResponse.Body.Close()
	callbackURL, err := url.Parse(providerResponse.Header.Get("Location"))
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodGet, callbackURL.RequestURI(), nil)
	req.AddCookie(start.Result().Cookies()[0])
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Len(t, e.auditEntries("user.oidc_linked"), 1)
	for _, action := range []string{"user.oidc_linked", "auth.login"} {
		entry := e.auditEntries(action)[0]
		require.Equal(t, fake.URL(), entry.Details["issuer"])
		require.Equal(t, "sub-1", entry.Details["sub"])
		require.Equal(t, "linked@example.com", entry.Details["email"])
	}
}
