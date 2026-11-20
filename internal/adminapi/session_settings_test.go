package adminapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/oidc/oidctest"
	"github.com/dottio123/ferricade/internal/store/db"
)

const sessionSettingsPath = apiPrefix + "/settings/sessions"

func setLifetime(t *testing.T, c *client, lifetime string) map[string]any {
	t.Helper()
	// send also lets the red-first run prove that the new route is absent.
	_, rec := c.send(http.MethodPut, sessionSettingsPath, map[string]any{"lifetime": lifetime})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	validateResponse(t, httptest.NewRequest(http.MethodPut, sessionSettingsPath, nil), rec)
	return decodeBody(t, rec)
}

func TestSessionSettingsAPI(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, ownerID := e.signedIn("owner", "owner")
	admin, _ := e.signedIn("admin", "admin")
	user, _ := e.signedIn("user", "user")
	_, rec := admin.send(http.MethodGet, sessionSettingsPath, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	validateResponse(t, httptest.NewRequest(http.MethodGet, sessionSettingsPath, nil), rec)
	require.Equal(t, map[string]any{"lifetime": "browser", "updated_at": nil, "updated_by": nil}, decodeBody(t, rec))
	requireError(t, admin.do(http.MethodPut, sessionSettingsPath, map[string]any{"lifetime": "7d"}), http.StatusForbidden, codeForbidden)
	requireError(t, user.do(http.MethodGet, sessionSettingsPath, nil), http.StatusForbidden, codeForbidden)
	requireError(t, user.do(http.MethodPut, sessionSettingsPath, map[string]any{"lifetime": "7d"}), http.StatusForbidden, codeForbidden)
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		requireError(t, e.client().do(method, sessionSettingsPath, nil), http.StatusUnauthorized, "unauthenticated")
	}
	for _, body := range []any{map[string]any{"lifetime": "forever"}, map[string]any{"lifetime": "7d", "extra": true}, map[string]any{}, map[string]any{"lifetime": nil}} {
		requireError(t, owner.do(http.MethodPut, sessionSettingsPath, body), http.StatusBadRequest, codeBadRequest)
	}
	owner.origin = "https://evil.example"
	requireError(t, owner.do(http.MethodPut, sessionSettingsPath, map[string]any{"lifetime": "7d"}), http.StatusForbidden, "csrf")
	owner.origin = ""
	csrf := owner.csrf
	owner.csrf = ""
	requireError(t, owner.do(http.MethodPut, sessionSettingsPath, map[string]any{"lifetime": "7d"}), http.StatusForbidden, "csrf")
	owner.csrf = csrf
	require.Empty(t, e.auditEntries("session_lifetime.changed"))
	unchanged := setLifetime(t, owner, "browser")
	require.Nil(t, unchanged["updated_at"])
	changed := setLifetime(t, owner, "7d")
	require.Equal(t, "7d", changed["lifetime"])
	require.Equal(t, e.clock.Now().Format(time.RFC3339), changed["updated_at"])
	require.Equal(t, ownerID.String(), changed["updated_by"].(map[string]any)["id"])
	entries := e.auditEntries("session_lifetime.changed")
	require.Len(t, entries, 1)
	require.Equal(t, map[string]any{"before": "browser", "after": "7d"}, entries[0].Details)
	require.Equal(t, &ownerID, entries[0].ActorUserID)
	e.clock.Add(time.Second)
	require.Equal(t, changed, setLifetime(t, owner, "7d"))
	require.Len(t, e.auditEntries("session_lifetime.changed"), 1)
}

func TestSessionLifetimeCookies(t *testing.T) {
	for _, tc := range []struct {
		lifetime string
		duration time.Duration
	}{{"browser", 7 * 24 * time.Hour}, {"8h", 8 * time.Hour}, {"1d", 24 * time.Hour}, {"7d", 7 * 24 * time.Hour}, {"30d", 30 * 24 * time.Hour}} {
		t.Run(tc.lifetime, func(t *testing.T) {
			e := newEnv(t)
			e.markSetupComplete()
			owner, _ := e.signedIn("owner", "owner")
			setLifetime(t, owner, tc.lifetime)
			c, _ := e.signedIn("admin", "admin")
			require.Equal(t, "__Host-ferricade_session", c.cookie.Name)
			require.True(t, c.cookie.Secure)
			require.True(t, c.cookie.HttpOnly)
			require.Equal(t, http.SameSiteStrictMode, c.cookie.SameSite)
			require.Equal(t, "/", c.cookie.Path)
			require.Empty(t, c.cookie.Domain)
			if tc.lifetime == "browser" {
				require.Zero(t, c.cookie.MaxAge)
				require.True(t, c.cookie.Expires.IsZero())
				e.clock.Add(5 * time.Minute)
				requireError(t, c.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
			} else {
				require.InDelta(t, int(tc.duration/time.Second), c.cookie.MaxAge, 1)
				e.clock.Add(6 * time.Hour)
				c.ok(http.MethodGet, apiPrefix+"/auth/me", nil)
				e.clock.Add(tc.duration - 6*time.Hour)
				requireError(t, c.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
			}
		})
	}
}

func TestSessionLifetimeTOTPRotation(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	setLifetime(t, owner, "1d")
	secret := newSecret(t)
	e.createUser("mfa", userOpts{totpSecret: secret})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("mfa", goodPassword).Code)
	oldCookie, oldCSRF := c.cookie, c.csrf
	original, err := e.d.Sessions.Lookup(t.Context(), db.New(e.d.Pool), c.cookie.Value)
	require.NoError(t, err)
	e.clock.Add(2 * time.Minute)
	rec := c.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]any{"code": e.totpCode(secret)})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.InDelta(t, 24*60*60-2*60, c.cookie.MaxAge, 1)
	require.NotEqual(t, oldCookie.Value, c.cookie.Value)
	require.NotEqual(t, oldCSRF, decodeBody(t, rec)["csrf_token"])
	rotated, err := e.d.Sessions.Lookup(t.Context(), db.New(e.d.Pool), c.cookie.Value)
	require.NoError(t, err)
	require.True(t, rotated.MFAPassed)
	require.Equal(t, original.ExpiresAt, rotated.ExpiresAt)
	require.Equal(t, original.CreatedAt, rotated.CreatedAt)
}

func TestSessionLifetimeStricterCapsOpenSessions(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, ownerID := e.signedIn("owner", "owner")
	setLifetime(t, owner, "30d")
	// The owner's own persistent session is also old enough to end immediately.
	require.Equal(t, http.StatusOK, owner.login("owner", goodPassword).Code)
	old, _ := e.signedIn("old", "admin")
	e.clock.Add(8 * time.Hour)
	young, _ := e.signedIn("young", "admin")
	created := e.clock.Now()
	e.clock.Add(time.Hour)
	setLifetime(t, owner, "8h")
	var expiry time.Time
	require.NoError(t, e.d.Pool.QueryRow(t.Context(), `SELECT expires_at FROM sessions WHERE user_id=$1`, ownerID).Scan(&expiry))
	require.Equal(t, created, expiry, "owner's session is capped too")
	requireError(t, owner.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
	requireError(t, old.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
	sess, err := e.d.Sessions.Lookup(t.Context(), db.New(e.d.Pool), young.cookie.Value)
	require.NoError(t, err)
	require.Equal(t, created.Add(8*time.Hour), sess.ExpiresAt)
	e.clock.Add(7 * time.Hour)
	requireError(t, young.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
}

func TestSessionLifetimeBrowserTransitions(t *testing.T) {
	for _, stricter := range []bool{true, false} {
		t.Run(map[bool]string{true: "stricter", false: "looser"}[stricter], func(t *testing.T) {
			e := newEnv(t)
			e.markSetupComplete()
			owner, _ := e.signedIn("owner", "owner")
			if stricter {
				setLifetime(t, owner, "7d")
			}
			c, _ := e.signedIn("admin", "admin")
			original, err := e.d.Sessions.Lookup(t.Context(), db.New(e.d.Pool), c.cookie.Value)
			require.NoError(t, err)
			if stricter {
				setLifetime(t, owner, "browser")
			} else {
				setLifetime(t, owner, "7d")
			}
			row, err := db.New(e.d.Pool).GetSession(t.Context(), original.ID)
			require.NoError(t, err)
			require.Equal(t, original.ExpiresAt, row.ExpiresAt)
			e.clock.Add(6 * time.Minute)
			_, err = e.d.Sessions.Check(t.Context(), db.New(e.d.Pool), original.ID)
			require.ErrorIs(t, err, auth.ErrNoSession)
			requireError(t, c.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
		})
	}
}

func TestSessionLifetimeOIDC(t *testing.T) {
	fake := oidctest.New()
	defer fake.Close()
	fake.Claims["groups"] = "admins"
	e := newEnv(t, func(d *Deps) { d.OIDCClient = fake.Server.Client() })
	fake.Now = e.clock.Now
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	setLifetime(t, owner, "7d")
	owner.ok(http.MethodPatch, apiPrefix+"/settings/oidc", map[string]any{"enabled": true, "issuer": fake.URL(), "client_id": "test-client", "client_secret": "test-secret", "admin_groups": []string{"admins"}, "jit_enabled": true})
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
	var cookie *http.Cookie
	for _, ck := range rec.Result().Cookies() {
		if ck.Name == sessionCookieName(e.d.Cfg) {
			cookie = ck
		}
	}
	require.NotNil(t, cookie)
	require.InDelta(t, 604800, cookie.MaxAge, 1)
	e.clock.Add(6 * time.Hour)
	c := e.client()
	c.cookie = cookie
	c.ok(http.MethodGet, apiPrefix+"/auth/me", nil)
}
