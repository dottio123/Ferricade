package adminapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/auth"
)

func TestCSRFRequired(t *testing.T) {
	e := newEnv(t)
	e.createUser("bob", userOpts{})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	csrf := c.csrf
	logout := apiPrefix + "/auth/logout"

	c.csrf = ""
	requireError(t, c.do(http.MethodPost, logout, nil), http.StatusForbidden, "csrf")
	c.csrf = csrf + "x"
	requireError(t, c.do(http.MethodPost, logout, nil), http.StatusForbidden, "csrf")

	c.csrf = csrf
	c.origin = "https://evil.example.com"
	requireError(t, c.do(http.MethodPost, logout, nil), http.StatusForbidden, "csrf")
	c.origin = "null"
	requireError(t, c.do(http.MethodPost, logout, nil), http.StatusForbidden, "csrf")
	c.origin = "http://admin.example.com" // scheme differs
	requireError(t, c.do(http.MethodPost, logout, nil), http.StatusForbidden, "csrf")
	c.origin = "-"
	requireError(t, c.do(http.MethodPost, logout, nil), http.StatusForbidden, "csrf")
	requireError(t, c.do(http.MethodPost, logout, nil, http.Header{"Referer": {"https://evil.example.com/x"}}),
		http.StatusForbidden, "csrf")
	// With no Origin, a matching Referer is accepted.
	rec := c.do(http.MethodPost, logout, nil, http.Header{"Referer": {"https://ADMIN.example.com:443/devices?x=1"}})
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	// Login itself needs the right origin too.
	c.origin = "https://evil.example.com"
	requireError(t, c.login("bob", goodPassword), http.StatusForbidden, "csrf")
	// GET is exempt.
	c.origin = "https://evil.example.com"
	requireError(t, c.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
}

func TestSecurityHeaders(t *testing.T) {
	check := func(e *env, hsts bool) {
		t.Helper()
		for _, path := range []string{apiPrefix + "/auth/me", "/setup/owner", apiPrefix + "/nope"} {
			var rec *httptest.ResponseRecorder
			if path == apiPrefix+"/auth/me" {
				rec = e.client().do(http.MethodGet, path, nil)
			} else {
				// Neither is documented (/setup/owner is POST only); the
				// headers are on every response all the same.
				rec = e.client().doOutsideContract(http.MethodGet, path)
			}
			h := rec.Header()
			require.Equal(t, "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
				h.Get("Content-Security-Policy"), path)
			require.Equal(t, "nosniff", h.Get("X-Content-Type-Options"), path)
			require.Equal(t, "no-referrer", h.Get("Referrer-Policy"), path)
			require.Equal(t, "same-origin", h.Get("Cross-Origin-Opener-Policy"), path)
			require.Equal(t, "no-store", h.Get("Cache-Control"), path)
			require.Len(t, h.Get("X-Request-ID"), 32, path)
			if hsts {
				require.Equal(t, "max-age=31536000", h.Get("Strict-Transport-Security"), path)
			} else {
				require.Empty(t, h.Get("Strict-Transport-Security"), path)
			}
		}
	}
	check(newEnv(t), true)
	check(newEnv(t, func(d *Deps) { d.Cfg.DevInsecure = true }), false)
}

func TestInternalErrorHasRequestID(t *testing.T) {
	a := newAPI(Deps{Log: quietLog()})
	h := a.requestID(a.securityHeaders(a.recoverer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/admin/api/v1/x", nil))
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	var body struct {
		Error struct {
			Code, Message string
			RequestID     string `json:"request_id"`
		}
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "internal", body.Error.Code)
	require.Equal(t, "internal error", body.Error.Message)
	require.NotEmpty(t, body.Error.RequestID)
	require.Equal(t, rec.Header().Get("X-Request-ID"), body.Error.RequestID)
	require.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))

	// http.ErrAbortHandler is not swallowed.
	abort := a.recoverer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) }))
	require.PanicsWithValue(t, http.ErrAbortHandler, func() {
		abort.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	})
}

func TestUnparsableClientAddressRejected(t *testing.T) {
	e := newEnv(t)
	e.createUser("bob", userOpts{})
	c := e.client()
	c.remote = "not-an-address"
	requireError(t, c.login("bob", goodPassword), http.StatusBadRequest, "bad_request")
	requireError(t, c.setup("/owner", ownerBody), http.StatusBadRequest, "bad_request")
	requireError(t, c.setup("/complete", nil), http.StatusBadRequest, "bad_request")

	// Every audited change records the address, so each one without a body
	// is refused too, before it looks at the resource.
	owner, _ := e.signedIn("alice", "owner")
	owner.remote = "not-an-address"
	id := uuid.NewString()
	for _, r := range []struct{ method, path string }{
		{http.MethodPost, apiPrefix + "/devices/" + id + "/approve"},
		{http.MethodPost, apiPrefix + "/devices/" + id + "/reject"},
		{http.MethodPost, apiPrefix + "/devices/" + id + "/archive"},
		{http.MethodPost, apiPrefix + "/devices/" + id + "/restore"},
		{http.MethodDelete, apiPrefix + "/devices/" + id},
		{http.MethodDelete, apiPrefix + "/groups/" + id},
		{http.MethodDelete, apiPrefix + "/tags/" + id},
		{http.MethodPost, apiPrefix + "/users/" + id + "/reset-totp"},
		{http.MethodPost, apiPrefix + "/auth/logout"},
	} {
		requireError(t, owner.do(r.method, r.path, nil), http.StatusBadRequest, "bad_request")
	}
}

func TestRequireRole(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	h := requireRole("owner")(ok)
	for role, want := range map[string]int{"owner": http.StatusTeapot, "admin": http.StatusForbidden} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req = req.WithContext(withAuth(req.Context(), authInfo{user: auth.User{Role: role}}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equal(t, want, rec.Code, role)
		if want == http.StatusForbidden {
			requireError(t, rec, http.StatusForbidden, "forbidden")
		}
	}
}

func TestContextHelpers(t *testing.T) {
	u := auth.User{Username: "bob"}
	s := auth.Session{CSRFToken: "t"}
	ctx := withAuth(context.Background(), authInfo{user: u, session: s, token: "tok"})
	require.Equal(t, u, userFrom(ctx))
	require.Equal(t, s, sessionFrom(ctx))
	require.Equal(t, auth.User{}, userFrom(context.Background()))
}

func TestUnknownAdminPathIsJSON404(t *testing.T) {
	e := newEnv(t)
	requireError(t, e.client().doOutsideContract(http.MethodGet, apiPrefix+"/nope"), http.StatusNotFound, "not_found")
	requireError(t, e.client().doOutsideContract(http.MethodDelete, apiPrefix+"/auth/me"), http.StatusNotFound, "not_found")
}
