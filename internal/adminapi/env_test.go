package adminapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/config"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/sessions"
	"github.com/dottio123/ferricade/internal/setup"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

const (
	publicURL    = "https://admin.example.com"
	goodPassword = "correct horse battery staple"
	validKey     = "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw="
	apiPrefix    = "/admin/api/v1"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Add(d time.Duration) { c.mu.Lock(); defer c.mu.Unlock(); c.t = c.t.Add(d) }

// env is an admin handler on a fresh test database with a fixed clock.
type env struct {
	t          *testing.T
	d          Deps
	h          http.Handler
	clock      *clock
	setupToken string
	dials      atomic.Int32
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newEnv(t *testing.T, mods ...func(*Deps)) *env {
	t.Helper()
	e := &env{t: t, clock: &clock{t: time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)}}
	u, err := url.Parse(publicURL)
	require.NoError(t, err)
	sealer, err := auth.NewSealer([]byte("0123456789abcdef0123456789abcdef"))
	require.NoError(t, err)
	p := store.NewTestDB(t)
	token, guard := setup.NewGuard(e.clock.Now)
	e.setupToken = token
	tracker := devices.NewTracker(e.clock.Now)
	e.d = Deps{
		Cfg:            config.Config{PublicURL: u, ClientListenAddr: ":21114"},
		Pool:           p,
		Sessions:       &auth.Sessions{Now: e.clock.Now},
		IPLimiter:      auth.NewIPLimiter(e.clock.Now),
		Sealer:         sealer,
		Params:         auth.TestParams,
		Setup:          &setup.Service{Pool: p, Sealer: sealer, Params: auth.TestParams, Now: e.clock.Now},
		Guard:          guard,
		Devices:        &devices.Service{Pool: p, Beats: tracker, MaxPending: 500, Now: e.clock.Now},
		Tracker:        tracker,
		Groups:         &devices.Groups{Pool: p},
		Tags:           &devices.Tags{Pool: p},
		RemoteSessions: &sessions.Service{Pool: p, Now: e.clock.Now},
		Now:            e.clock.Now,
		Log:            quietLog(),
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			e.dials.Add(1)
			c1, c2 := net.Pipe()
			c2.Close()
			return c1, nil
		},
	}
	for _, m := range mods {
		m(&e.d)
	}
	e.h = New(e.d)
	return e
}

// client is a browser: it keeps the session cookie and the CSRF token.
type client struct {
	e      *env
	cookie *http.Cookie
	csrf   string
	remote string // RemoteAddr; empty means httptest's 192.0.2.1:1234
	origin string // Origin header; empty means publicURL, "-" means none
}

func (e *env) client() *client { return &client{e: e} }

// do sends a request and checks the response against openapi.yaml
// (validateResponse).
func (c *client) do(method, path string, body any, hdrs ...http.Header) *httptest.ResponseRecorder {
	c.e.t.Helper()
	req, rec := c.send(method, path, body, hdrs...)
	validateResponse(c.e.t, req, rec)
	return rec
}

// rawBody is sent as is, without json.Marshal (which would compact it).
type rawBody []byte

// send sends a request as the browser would: with its cookie, CSRF token and
// origin, keeping any session cookie the response sets.
func (c *client) send(method, path string, body any, hdrs ...http.Header) (*http.Request, *httptest.ResponseRecorder) {
	c.e.t.Helper()
	var rd io.Reader
	if raw, ok := body.(rawBody); ok {
		rd = bytes.NewReader(raw)
	} else if body != nil {
		raw, err := json.Marshal(body)
		require.NoError(c.e.t, err)
		rd = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, rd)
	if c.remote != "" {
		req.RemoteAddr = c.remote
	}
	switch c.origin {
	case "":
		req.Header.Set("Origin", publicURL)
	case "-":
	default:
		req.Header.Set("Origin", c.origin)
	}
	if c.csrf != "" {
		req.Header.Set("X-CSRF-Token", c.csrf)
	}
	if c.cookie != nil {
		req.AddCookie(c.cookie)
	}
	for _, h := range hdrs {
		for k, v := range h {
			req.Header[k] = v
		}
	}
	rec := httptest.NewRecorder()
	c.e.h.ServeHTTP(rec, req)
	for _, ck := range rec.Result().Cookies() {
		if ck.Name != sessionCookieName(c.e.d.Cfg) {
			continue
		}
		if ck.MaxAge < 0 {
			c.cookie = nil
		} else {
			c.cookie = ck
		}
	}
	return req, rec
}

// login signs in and keeps the CSRF token from the response.
func (c *client) login(username, password string) *httptest.ResponseRecorder {
	c.e.t.Helper()
	rec := c.do(http.MethodPost, apiPrefix+"/auth/login", map[string]string{"username": username, "password": password})
	if rec.Code == http.StatusOK {
		c.csrf = decodeBody(c.e.t, rec)["csrf_token"].(string)
	}
	return rec
}

func (c *client) setup(path string, body any) *httptest.ResponseRecorder {
	c.e.t.Helper()
	return c.do(http.MethodPost, "/setup"+path, body, http.Header{"X-Setup-Token": {c.e.setupToken}})
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &m), rec.Body.String())
	return m
}

// requireError checks an admin error response.
func requireError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	require.Equal(t, status, rec.Code, rec.Body.String())
	require.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	errObj, ok := decodeBody(t, rec)["error"].(map[string]any)
	require.True(t, ok, rec.Body.String())
	require.Equal(t, code, errObj["code"], rec.Body.String())
	require.NotEmpty(t, errObj["message"])
}

type userOpts struct {
	role         string
	totpSecret   string
	totpRequired bool
}

// createUser inserts an active user with password goodPassword.
func (e *env) createUser(username string, o userOpts) uuid.UUID {
	e.t.Helper()
	ctx := context.Background()
	hash, err := auth.HashPassword(context.Background(), goodPassword, auth.TestParams)
	require.NoError(e.t, err)
	if o.role == "" {
		o.role = "admin"
	}
	q := db.New(e.d.Pool)
	row, err := q.CreateUser(ctx, db.CreateUserParams{
		Username: username, Role: o.role, PasswordHash: &hash, TOTPRequired: o.totpRequired,
	})
	require.NoError(e.t, err)
	if o.totpSecret != "" {
		sealed, err := e.d.Sealer.Seal([]byte(o.totpSecret))
		require.NoError(e.t, err)
		require.NoError(e.t, q.SetTOTP(ctx, db.SetTOTPParams{ID: row.ID, TOTPSecretEnc: sealed}))
	}
	return row.ID
}

// markSetupComplete stores a server profile and the setup_complete flag
// directly, for tests of the admin API proper.
func (e *env) markSetupComplete() db.Server {
	e.t.Helper()
	ctx := context.Background()
	q := db.New(e.d.Pool)
	srv, err := q.CreateServer(ctx, db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "relay.example.com", PublicKey: validKey,
	})
	require.NoError(e.t, err)
	require.NoError(e.t, q.PutSetting(ctx, db.PutSettingParams{Key: setup.KeySetupComplete, Value: []byte(`true`)}))
	return srv
}

func (e *env) totpCode(secret string) string {
	e.t.Helper()
	c, err := auth.TOTPCode(secret, e.clock.Now())
	require.NoError(e.t, err)
	return c
}

func (e *env) auditEntries(action string) []audit.Entry {
	e.t.Helper()
	entries, _, err := audit.List(context.Background(), db.New(e.d.Pool), audit.Filter{Action: action, Limit: 200})
	require.NoError(e.t, err)
	return entries
}

func newSecret(t *testing.T) string {
	t.Helper()
	s, err := auth.NewTOTPSecret()
	require.NoError(t, err)
	return s
}
