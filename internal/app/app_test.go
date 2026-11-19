package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/app"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/config"
	"github.com/dottio123/ferricade/internal/events"
	"github.com/dottio123/ferricade/internal/setup"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// syncBuffer is a log destination safe for the app's goroutines.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

// records returns the JSON log records written so far.
func (s *syncBuffer) records(t *testing.T) []map[string]any {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []map[string]any
	dec := json.NewDecoder(bytes.NewReader(s.b.Bytes()))
	for dec.More() {
		var r map[string]any
		require.NoError(t, dec.Decode(&r))
		out = append(out, r)
	}
	return out
}

// newConfig returns a DEV_INSECURE config on a fresh test database, and a
// pool on that database for the test's own checks.
func newConfig(t *testing.T) (config.Config, *db.Queries) {
	t.Helper()
	pool := store.NewTestDB(t)
	name := pool.Config().ConnConfig.Database
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if u, err := url.Parse(dbURL); err == nil && (u.Scheme == "postgres" || u.Scheme == "postgresql") {
		u.Path = "/" + name
		dbURL = u.String()
	} else {
		dbURL += " dbname=" + name
	}
	pub, err := url.Parse("http://127.0.0.1:21120")
	require.NoError(t, err)
	return config.Config{
		DatabaseURL: dbURL,
		PublicURL:   pub,
		SecretKey:   bytes.Repeat([]byte{7}, 32),
		DevInsecure: true,
	}, db.New(pool)
}

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := ln.Addr().String()
	require.NoError(t, ln.Close())
	return addr
}

func TestSetupTokenLoggedOnceAtWarn(t *testing.T) {
	cfg, _ := newConfig(t)
	var logs syncBuffer
	a, err := app.New(context.Background(), cfg, slog.New(slog.NewJSONHandler(&logs, nil)))
	require.NoError(t, err)
	t.Cleanup(a.Close)

	token := a.SetupToken()
	require.NotEmpty(t, token)
	var found []map[string]any
	for _, r := range logs.records(t) {
		if strings.Contains(r["msg"].(string), token) {
			found = append(found, r)
		}
	}
	require.Len(t, found, 1, "the token is logged exactly once")
	assert.Equal(t, "setup token: "+token, found[0]["msg"])
	assert.Equal(t, "WARN", found[0]["level"])
	// The web UI's wizard is the way in; scripts can still drive the API.
	assert.Equal(t, "http://127.0.0.1:21120/first-run", found[0]["setup_url"])
	assert.Equal(t, "http://127.0.0.1:21120/setup", found[0]["setup_api_base"])
	assert.Contains(t, found[0]["hint"], "open setup_url in a browser")
	assert.Contains(t, found[0]["hint"], "X-Setup-Token")
	assert.Contains(t, found[0]["hint"], `README.md, section "Complete setup"`)
	assert.NotContains(t, found[0]["hint"], "not a web page")
}

func TestNoSetupTokenOnceSetupIsComplete(t *testing.T) {
	cfg, q := newConfig(t)
	ctx := context.Background()
	_, err := q.CreateServer(ctx, db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=",
	})
	require.NoError(t, err)
	require.NoError(t, q.PutSetting(ctx, db.PutSettingParams{Key: setup.KeySetupComplete, Value: []byte(`true`)}))

	var logs syncBuffer
	a, err := app.New(ctx, cfg, slog.New(slog.NewJSONHandler(&logs, nil)))
	require.NoError(t, err)
	t.Cleanup(a.Close)
	assert.Empty(t, a.SetupToken())
	for _, r := range logs.records(t) {
		assert.NotContains(t, r["msg"], "setup token")
	}
}

func TestDevInsecureWarnsAtStartup(t *testing.T) {
	cfg, _ := newConfig(t)
	var logs syncBuffer
	a, err := app.New(context.Background(), cfg, slog.New(slog.NewJSONHandler(&logs, nil)))
	require.NoError(t, err)
	t.Cleanup(a.Close)
	warned := false
	for _, r := range logs.records(t) {
		if strings.HasPrefix(r["msg"].(string), "DEV_INSECURE=1") && r["level"] == "WARN" {
			warned = true
		}
	}
	assert.True(t, warned)
}

func TestRunServesBothListenersAndStops(t *testing.T) {
	cfg, _ := newConfig(t)
	cfg.ClientListenAddr, cfg.AdminListenAddr = freeAddr(t), freeAddr(t)
	a, err := app.New(context.Background(), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ran := make(chan error, 1)
	go func() { ran <- a.Run(ctx) }()

	for _, addr := range []string{cfg.ClientListenAddr, cfg.AdminListenAddr} {
		require.Eventually(t, func() bool {
			resp, err := http.Get("http://" + addr + "/healthz")
			if err != nil {
				return false
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			return resp.StatusCode == http.StatusOK && string(body) == "ok"
		}, 5*time.Second, 20*time.Millisecond, addr)
	}

	cancel()
	select {
	case err := <-ran:
		require.NoError(t, err)
	case <-time.After(15 * time.Second):
		t.Fatal("Run did not return after its context ended")
	}
	_, err = http.Get("http://" + cfg.ClientListenAddr + "/healthz")
	assert.Error(t, err, "the client listener is closed")
	a.Close() // safe after Run
}

func TestRunFailsWhenAPortIsTaken(t *testing.T) {
	cfg, _ := newConfig(t)
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer busy.Close()
	cfg.ClientListenAddr, cfg.AdminListenAddr = freeAddr(t), busy.Addr().String()
	a, err := app.New(context.Background(), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)

	err = a.Run(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "admin listener")
}

// waitFor returns the first event on ch of type typ, skipping others.
func waitFor(t *testing.T, ch <-chan events.Event, typ string) events.Event {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case e, ok := <-ch:
			require.True(t, ok, "subscription closed")
			if e.Type == typ {
				return e
			}
		case <-deadline:
			t.Fatalf("no %s event within 10 s", typ)
		}
	}
}

func TestHubGetsDatabaseAndTrackerEvents(t *testing.T) {
	cfg, q := newConfig(t)
	ctx := context.Background()
	_, err := q.CreateServer(ctx, db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=",
	})
	require.NoError(t, err)
	require.NoError(t, q.PutSetting(ctx, db.PutSettingParams{Key: setup.KeySetupComplete, Value: []byte(`true`)}))
	pool, err := store.Open(ctx, cfg.DatabaseURL)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	a, err := app.New(ctx, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)
	t.Cleanup(a.Close)
	ch, unsub := a.Hub().Subscribe("")
	t.Cleanup(unsub)

	require.Eventually(t, func() bool {
		var n int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND query = 'LISTEN ferricade_events' AND state = 'idle'`).Scan(&n)
		return err == nil && n == 1
	}, 5*time.Second, 20*time.Millisecond, "the app listens for database events")

	// A first heartbeat enrolls the device (audited, so a database event)
	// and puts it online (a tracker event).
	req := httptest.NewRequest(http.MethodPost, "/api/heartbeat", strings.NewReader(`{"id":"424242","uuid":"ZmFrZQ=="}`))
	rec := httptest.NewRecorder()
	a.ClientHandler().ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var deviceID string
	require.NoError(t, pool.QueryRow(ctx, `SELECT id::text FROM devices WHERE rustdesk_id = '424242'`).Scan(&deviceID))
	assert.Equal(t, events.Event{Type: events.TypeDeviceEnrolled, DeviceID: deviceID}, waitFor(t, ch, events.TypeDeviceEnrolled))
	assert.Equal(t, events.Event{Type: events.TypeDeviceOnline, DeviceID: deviceID}, waitFor(t, ch, events.TypeDeviceOnline))
}

// TestHubGetsSessionUpdated: a connection's auth record, after its "new",
// reaches the hub as session.updated for the session "new" started.
func TestHubGetsSessionUpdated(t *testing.T) {
	cfg, q := newConfig(t)
	ctx := context.Background()
	_, err := q.CreateServer(ctx, db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=",
	})
	require.NoError(t, err)
	require.NoError(t, q.PutSetting(ctx, db.PutSettingParams{Key: setup.KeySetupComplete, Value: []byte(`true`)}))
	pool, err := store.Open(ctx, cfg.DatabaseURL)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	a, err := app.New(ctx, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)
	t.Cleanup(a.Close)
	ch, unsub := a.Hub().Subscribe("")
	t.Cleanup(unsub)
	require.Eventually(t, func() bool {
		var n int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND query = 'LISTEN ferricade_events' AND state = 'idle'`).Scan(&n)
		return err == nil && n == 1
	}, 5*time.Second, 20*time.Millisecond, "the app listens for database events")

	post := func(path, body string) {
		t.Helper()
		rec := httptest.NewRecorder()
		a.ClientHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
	post("/api/heartbeat", `{"id":"424242","uuid":"ZmFrZQ=="}`)
	var deviceID string
	require.NoError(t, pool.QueryRow(ctx, `SELECT id::text FROM devices WHERE rustdesk_id = '424242'`).Scan(&deviceID))
	_, err = pool.Exec(ctx, `UPDATE devices SET state = 'approved' WHERE rustdesk_id = '424242'`)
	require.NoError(t, err)

	post("/api/audit/conn", `{"id":"424242","uuid":"ZmFrZQ==","conn_id":7,"nonce":"n-new","action":"new","ip":"203.0.113.7"}`)
	started := waitFor(t, ch, events.TypeSessionStarted)
	require.Equal(t, deviceID, started.DeviceID)
	require.NotEmpty(t, started.SessionID)

	post("/api/audit/conn", `{"id":"424242","uuid":"ZmFrZQ==","conn_id":7,"nonce":"n-auth","peer":["555","laptop"],"type":0}`)
	assert.Equal(t, events.Event{Type: events.TypeSessionUpdated, SessionID: started.SessionID, DeviceID: deviceID},
		waitFor(t, ch, events.TypeSessionUpdated))
}

// TestRunEndsEventStreamsOnShutdown: an open event stream would otherwise
// hold the admin listener's shutdown for the whole drain period.
func TestRunEndsEventStreamsOnShutdown(t *testing.T) {
	cfg, q := newConfig(t)
	cfg.ClientListenAddr, cfg.AdminListenAddr = freeAddr(t), freeAddr(t)
	ctx := context.Background()
	_, err := q.CreateServer(ctx, db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=",
	})
	require.NoError(t, err)
	require.NoError(t, q.PutSetting(ctx, db.PutSettingParams{Key: setup.KeySetupComplete, Value: []byte(`true`)}))
	hash := "x"
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", Role: "owner", PasswordHash: &hash})
	require.NoError(t, err)
	token, _, err := (&auth.Sessions{}).Create(ctx, q, user.ID, netip.MustParseAddr("127.0.0.1"), "test")
	require.NoError(t, err)

	a, err := app.New(ctx, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	ran := make(chan error, 1)
	go func() { ran <- a.Run(runCtx) }()

	// A device beats twice, so its last beat is newer than its enrollment;
	// only the final flush on shutdown can store it.
	beat := func() bool {
		resp, err := http.Post("http://"+cfg.ClientListenAddr+"/api/heartbeat", "application/json",
			strings.NewReader(`{"id":"424242","uuid":"ZmFrZQ=="}`))
		if err != nil {
			return false
		}
		resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	}
	require.Eventually(t, beat, 5*time.Second, 20*time.Millisecond)
	time.Sleep(10 * time.Millisecond)
	require.True(t, beat())

	req, err := http.NewRequest(http.MethodGet, "http://"+cfg.AdminListenAddr+"/admin/api/v1/events", nil)
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: "ferricade_session", Value: token})
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "text/event-stream", resp.Header.Get("Content-Type"))
	streamDone := make(chan string, 1)
	go func() {
		body, _ := io.ReadAll(resp.Body)
		streamDone <- string(body)
	}()
	require.Eventually(t, func() bool { return a.Hub().Subscribers() == 1 }, 5*time.Second, 10*time.Millisecond)

	start := time.Now()
	cancel()
	select {
	case err := <-ran:
		require.NoError(t, err)
	case <-time.After(15 * time.Second):
		t.Fatal("Run did not return after its context ended")
	}
	took := time.Since(start)
	assert.Less(t, took, 2*time.Second, "Run waited for the event stream")
	select {
	case body := <-streamDone:
		assert.Contains(t, body, "event: resync\ndata: {\"type\":\"resync\"}\n\n", "the stream was told to resync")
	case <-time.After(5 * time.Second):
		t.Fatal("the event stream is still open after Run returned")
	}

	check, err := store.Open(ctx, cfg.DatabaseURL)
	require.NoError(t, err)
	defer check.Close()
	var flushed bool
	require.NoError(t, check.QueryRow(ctx,
		`SELECT last_seen_at > first_seen_at FROM devices WHERE rustdesk_id = '424242'`).Scan(&flushed))
	assert.True(t, flushed, "the final flush stored the last heartbeat")
}

func TestStartupSummaryAndGuidanceLogs(t *testing.T) {
	cfg, q := newConfig(t)
	cfg.LogLevel = slog.LevelDebug
	cfg.LogFormat = "json"
	cfg.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}

	// Ensure a secret password in DatabaseURL is never logged.
	u, err := url.Parse(cfg.DatabaseURL)
	if err == nil && (u.Scheme == "postgres" || u.Scheme == "postgresql") {
		if u.User != nil {
			u.User = url.UserPassword(u.User.Username(), "super-secret-db-pass-987")
		}
	}

	ctx := context.Background()
	_, err = q.CreateServer(ctx, db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "", // empty public key should trigger setup guidance warn
	})
	require.NoError(t, err)
	require.NoError(t, q.PutSetting(ctx, db.PutSettingParams{Key: setup.KeySetupComplete, Value: []byte(`true`)}))

	var logs syncBuffer
	a, err := app.New(ctx, cfg, slog.New(slog.NewJSONHandler(&logs, nil)))
	require.NoError(t, err)
	t.Cleanup(a.Close)

	raw := logs.b.String()
	assert.NotContains(t, raw, "super-secret-db-pass-987")
	if u != nil {
		if pw, ok := u.User.Password(); ok && pw != "" {
			assert.NotContains(t, raw, pw)
		}
	}

	records := logs.records(t)
	var sawDB, sawStart, sawPubKeyWarn bool
	for _, r := range records {
		msg, _ := r["msg"].(string)
		switch {
		case msg == "database ready":
			sawDB = true
			assert.Equal(t, "INFO", r["level"])
			assert.Contains(t, r, "migrations_from")
			assert.Contains(t, r, "migrations_to")
		case msg == "starting ferricade":
			sawStart = true
			assert.Equal(t, "INFO", r["level"])
			assert.Contains(t, r, "version")
			assert.Equal(t, "http://127.0.0.1:21120", r["public_url"])
			assert.Equal(t, ":21114", r["client_addr"])
			assert.Equal(t, ":21120", r["admin_addr"])
			assert.Equal(t, "debug", r["log_level"])
			assert.Equal(t, "json", r["log_format"])
			assert.Equal(t, true, r["setup_complete"])
			assert.Equal(t, float64(1), r["trusted_proxies"])
			assert.Equal(t, true, r["dev_insecure"])
		case r["level"] == "WARN" && strings.Contains(msg, "public key"):
			sawPubKeyWarn = true
		}
	}
	assert.True(t, sawDB, "expected database ready log")
	assert.True(t, sawStart, "expected starting ferricade log")
	assert.True(t, sawPubKeyWarn, "expected server public key warning when setup is complete and public_key is empty")
}
