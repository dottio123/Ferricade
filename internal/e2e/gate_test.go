// Package e2e holds the Phase 1a and 1b backend gates: the whole server, built by app.New on
// a real database, driven only through its two HTTP listeners.
package e2e_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/app"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/config"
	"github.com/dottio123/ferricade/internal/policies"
	"github.com/dottio123/ferricade/internal/sim"
	"github.com/dottio123/ferricade/internal/stats"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/web"
)

const (
	ownerPassword = "correct horse battery staple"
	serverKey     = "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw="
	apiPrefix     = "/admin/api/v1"
)

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func secretKey(t *testing.T) string {
	t.Helper()
	var b [32]byte
	_, err := rand.Read(b[:])
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(b[:])
}

// testDatabaseURL creates a throwaway database with store.NewTestDB and
// returns a URL for it, so app.New can open its own pool as in production.
func testDatabaseURL(t *testing.T) string {
	t.Helper()
	name := store.NewTestDB(t).Config().ConnConfig.Database
	base := os.Getenv("TEST_DATABASE_URL")
	if u, err := url.Parse(base); err == nil && (u.Scheme == "postgres" || u.Scheme == "postgresql") {
		u.Path = "/" + name
		return u.String()
	}
	return base + " dbname=" + name // keyword/value form: the last dbname wins
}

// browser talks to the admin listener the way the web UI will: a cookie
// jar for the session, an Origin header on every request, and the CSRF
// token from the last login or TOTP step on state-changing ones.
type browser struct {
	t      *testing.T
	base   string // the admin listener's URL, which is also PUBLIC_URL
	client *http.Client
	csrf   string
	setup  string // X-Setup-Token, for /setup requests
}

func newBrowser(t *testing.T, base string) *browser {
	t.Helper()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	return &browser{t: t, base: base, client: &http.Client{Jar: jar, Timeout: 30 * time.Second}}
}

// expect sends a request, requires the reply status to be want, and decodes a
// JSON reply into out when out is not nil.
func (b *browser) expect(want int, method, path string, body, out any) {
	b.t.Helper()
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		require.NoError(b.t, err)
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, b.base+path, rd)
	require.NoError(b.t, err)
	req.Header.Set("Origin", b.base)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if b.csrf != "" && method != http.MethodGet {
		req.Header.Set("X-CSRF-Token", b.csrf)
	}
	if b.setup != "" && strings.HasPrefix(path, "/setup/") {
		req.Header.Set("X-Setup-Token", b.setup)
	}
	resp, err := b.client.Do(req)
	require.NoError(b.t, err)
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(b.t, err)
	require.Equal(b.t, want, resp.StatusCode, "%s %s: %s", method, path, raw)
	if out != nil {
		require.NoError(b.t, json.Unmarshal(raw, out), "%s %s: %s", method, path, raw)
	}
}

func totp(t *testing.T, secret string, at time.Time) string {
	t.Helper()
	code, err := auth.TOTPCode(secret, at)
	require.NoError(t, err)
	return code
}

type device struct {
	ID         string `json:"id"`
	RustdeskID string `json:"rustdesk_id"`
	State      string `json:"state"`
	Online     bool   `json:"online"`
}

// TestPhase1bBackendGate extends the Phase 1a gate (setup, enrolment, approval,
// connect link, audit) with sessions, live events, stats and UI serving.
func TestPhase1bBackendGate(t *testing.T) {
	ctx := context.Background()
	dbURL := testDatabaseURL(t)

	// The admin listener's address is known before the app is built, so it
	// can be PUBLIC_URL, as in the README's LAN-test mode.
	adminSrv := httptest.NewUnstartedServer(nil)
	publicURL := "http://" + adminSrv.Listener.Addr().String()
	env := map[string]string{
		"DATABASE_URL": dbURL,
		"SECRET_KEY":   secretKey(t),
		"PUBLIC_URL":   publicURL,
		"DEV_INSECURE": "1",
	}
	cfg, err := config.Load(func(k string) string { return env[k] })
	require.NoError(t, err)
	cfg.LogExportDir = t.TempDir()

	a, err := app.New(ctx, cfg, quietLog())
	require.NoError(t, err)
	t.Cleanup(a.Close)
	adminSrv.Config.Handler = a.AdminHandler()
	adminSrv.Start()
	t.Cleanup(adminSrv.Close)
	clientSrv := httptest.NewServer(a.ClientHandler())
	t.Cleanup(clientSrv.Close)

	token := a.SetupToken()
	require.NotEmpty(t, token, "a fresh database needs setup")

	// 1. Setup through the API: owner, owner TOTP, server, complete.
	b := newBrowser(t, publicURL)
	b.setup = token
	b.expect(http.StatusCreated, http.MethodPost, "/setup/owner", map[string]string{
		"username": "owner", "password": ownerPassword, "display_name": "Owner", "email": "owner@example.com",
	}, nil)
	var enroll struct {
		Secret string `json:"secret"`
	}
	b.expect(http.StatusOK, http.MethodPost, "/setup/owner/totp", nil, &enroll)
	require.NotEmpty(t, enroll.Secret)
	b.expect(http.StatusOK, http.MethodPost, "/setup/owner/totp/verify",
		map[string]string{"code": totp(t, enroll.Secret, time.Now())}, nil)
	var saved struct {
		Saved bool `json:"saved"`
	}
	b.expect(http.StatusOK, http.MethodPost, "/setup/server", map[string]string{
		"name": "lab", "id_host": "127.0.0.1", "relay_host": "127.0.0.1", "public_key": serverKey,
	}, &saved)
	require.True(t, saved.Saved)
	var done struct {
		ClientConfig struct {
			API string `json:"api"`
			Key string `json:"key"`
		} `json:"client_config"`
	}
	b.expect(http.StatusOK, http.MethodPost, "/setup/complete", nil, &done)
	assert.Equal(t, "http://127.0.0.1:21114", done.ClientConfig.API)
	assert.Equal(t, serverKey, done.ClientConfig.Key)
	assert.Empty(t, a.SetupToken(), "the setup token is gone once setup is complete")
	b.expect(http.StatusNotFound, http.MethodPost, "/setup/complete", nil, nil)
	b.setup = ""

	// Sign in like a browser: password, then a TOTP code from the next time
	// step (the current one was spent verifying the secret).
	var login struct {
		MFARequired bool   `json:"mfa_required"`
		CSRFToken   string `json:"csrf_token"`
	}
	b.expect(http.StatusOK, http.MethodPost, apiPrefix+"/auth/login",
		map[string]string{"username": "owner", "password": ownerPassword}, &login)
	require.True(t, login.MFARequired)
	require.NotEmpty(t, login.CSRFToken)
	b.csrf = login.CSRFToken
	var mfa struct {
		CSRFToken string `json:"csrf_token"`
	}
	b.expect(http.StatusOK, http.MethodPost, apiPrefix+"/auth/totp",
		map[string]string{"code": totp(t, enroll.Secret, time.Now().Add(30*time.Second))}, &mfa)
	require.NotEmpty(t, mfa.CSRFToken)
	b.csrf = mfa.CSRFToken
	b.expect(http.StatusOK, http.MethodPut, apiPrefix+"/settings/log-export", map[string]any{
		"file": map[string]any{"enabled": true},
		"syslog": map[string]any{"enabled": false, "host": "", "port": 6514,
			"tls": true, "ca_pem": "", "facility": "local0", "format": "json"},
	}, nil)

	// 2. Three simulated devices heartbeat against the client listener.
	simCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	simStats, err := sim.Run(simCtx, sim.Options{API: clientSrv.URL, Devices: 3, Interval: 50 * time.Millisecond, StopAfterHeartbeats: 3})
	require.NoError(t, err)
	require.Zero(t, simStats.Errors)
	require.Positive(t, simStats.Heartbeats)

	// 3. All three are pending.
	var pending struct {
		Items []device `json:"items"`
	}
	b.expect(http.StatusOK, http.MethodGet, apiPrefix+"/devices?state=pending", nil, &pending)
	require.Len(t, pending.Items, 3)
	var first device
	for _, d := range pending.Items {
		if d.RustdeskID == "100000000" {
			first = d
		}
	}
	require.NotEmpty(t, first.ID, "device 100000000 is pending")

	// 4. Approve the first; it is approved and online. Without the CSRF
	// header the session cookie alone is refused.
	csrf := b.csrf
	b.csrf = ""
	b.expect(http.StatusForbidden, http.MethodPost, apiPrefix+"/devices/"+first.ID+"/approve", nil, nil)
	b.csrf = csrf
	b.expect(http.StatusOK, http.MethodPost, apiPrefix+"/devices/"+first.ID+"/approve", nil, nil)
	// Rules run through the real client and admin listeners at approval.
	var group struct {
		ID string `json:"id"`
	}
	b.expect(http.StatusCreated, http.MethodPost, apiPrefix+"/groups", map[string]string{"name": "IT Workstations"}, &group)
	b.expect(http.StatusCreated, http.MethodPost, apiPrefix+"/groups/"+group.ID+"/rules", map[string]string{"pattern": "w-*-it-*"}, nil)
	for _, request := range []struct{ path, body string }{
		{"/api/heartbeat", `{"id":"144000001","uuid":"t144","ver":1}`},
		{"/api/sysinfo", `{"id":"144000001","uuid":"t144","hostname":"w-sf-it-1"}`},
	} {
		resp, err := http.Post(clientSrv.URL+request.path, "application/json", strings.NewReader(request.body))
		require.NoError(t, err)
		require.Equal(t, 200, resp.StatusCode)
		resp.Body.Close()
	}
	var ruleDevices struct {
		Items []device `json:"items"`
	}
	b.expect(http.StatusOK, http.MethodGet, apiPrefix+"/devices?state=pending", nil, &ruleDevices)
	foundRuleDevice := false
	for _, d := range ruleDevices.Items {
		if d.RustdeskID == "144000001" {
			var placed struct {
				GroupID string `json:"group_id"`
			}
			b.expect(http.StatusOK, http.MethodPost, apiPrefix+"/devices/"+d.ID+"/approve", nil, &placed)
			require.Equal(t, group.ID, placed.GroupID)
			b.expect(http.StatusNoContent, http.MethodDelete, apiPrefix+"/devices/"+d.ID, nil, nil)
			foundRuleDevice = true
		}
	}
	require.True(t, foundRuleDevice, "the rule device enrolled through the client listener")
	require.Eventually(t, func() bool {
		data, err := os.ReadFile(filepath.Join(cfg.LogExportDir, "events.jsonl"))
		return err == nil && strings.Contains(string(data), `"action":"device.approved"`) &&
			strings.Contains(string(data), `"message":`)
	}, 10*time.Second, 100*time.Millisecond, "approved device should be exported")
	var got device
	b.expect(http.StatusOK, http.MethodGet, apiPrefix+"/devices/"+first.ID, nil, &got)
	assert.Equal(t, "approved", got.State)
	assert.True(t, got.Online)
	policyDB, err := store.Open(ctx, dbURL)
	require.NoError(t, err)
	defer policyDB.Close()
	_, err = policyDB.Exec(ctx, `UPDATE client_policy_settings SET push_enabled = true`)
	require.NoError(t, err)
	strategyCtx, stopStrategy := context.WithTimeout(ctx, 10*time.Second)
	defer stopStrategy()
	strategyStats, err := sim.Run(strategyCtx, sim.Options{API: clientSrv.URL, Devices: 3, Interval: 50 * time.Millisecond, StopAfterHeartbeats: 9})
	require.NoError(t, err)
	require.Zero(t, strategyStats.Errors)
	require.Positive(t, strategyStats.Strategies)
	var strategySeen *int64
	require.NoError(t, policyDB.QueryRow(ctx, `SELECT strategy_version_seen FROM devices WHERE id = $1`, first.ID).Scan(&strategySeen))
	wantSettings := policies.DefaultSettings()
	wantSettings["id-whitelist"] = ""
	wantVersion := policies.Version(wantSettings)
	require.Equal(t, &wantVersion, strategySeen)

	// 5. Its connect link.
	var link struct {
		URL string `json:"url"`
	}
	b.expect(http.StatusOK, http.MethodGet, apiPrefix+"/devices/"+first.ID+"/connect", nil, &link)
	assert.Equal(t, "rustdesk://100000000@127.0.0.1?key=OeVuKk5nlHiXp%2BAPNn0Y3pC1Iwpwn44JGqrQCsWqmBw=", link.URL)

	// 6. Every step is in the audit log.
	var auditLog struct {
		Items []struct {
			Action string `json:"action"`
		} `json:"items"`
	}
	b.expect(http.StatusOK, http.MethodGet, apiPrefix+"/audit?limit=200", nil, &auditLog)
	counts := map[string]int{}
	for _, e := range auditLog.Items {
		counts[e.Action]++
	}
	assert.Equal(t, 1, counts["setup.completed"], counts)
	assert.Equal(t, 4, counts["device.enrolled"], counts)
	assert.Equal(t, 2, counts["device.approved"], counts)
	assert.Equal(t, 1, counts["device.connect_link"], counts)

	// 7. Phase 1b: live events, sessions and stats. The sessions of device
	// 100000000 (approved above) open and close while the event stream runs.
	events := b.openEvents(ctx)
	sessCtx, stopSim := context.WithCancel(ctx)
	simDone := make(chan sim.Stats, 1)
	go func() {
		st, _ := sim.Run(sessCtx, sim.Options{
			API: clientSrv.URL, Devices: 1, Interval: 100 * time.Millisecond,
			SessionEvery: 4 * time.Second, SessionLength: 2 * time.Second,
		})
		simDone <- st
	}()
	defer stopSim()

	started := events.next(t, "session.started", 15*time.Second)
	assert.Contains(t, started, `"`+first.ID+`"`, "the event names the device")

	var active struct {
		Items []struct {
			ID         string  `json:"id"`
			DeviceID   string  `json:"device_id"`
			RustdeskID string  `json:"rustdesk_id"`
			PeerID     string  `json:"peer_rustdesk_id"`
			PeerName   string  `json:"peer_name"`
			Type       string  `json:"type"`
			ClientIP   *string `json:"client_ip"`
			EndedAt    *string `json:"ended_at"`
		} `json:"items"`
	}
	// The event fires on the "new" record; the peer arrives with the auth one.
	require.Eventually(t, func() bool {
		b.expect(http.StatusOK, http.MethodGet, apiPrefix+"/sessions?active=true", nil, &active)
		return len(active.Items) == 1 && active.Items[0].PeerID == "900000000"
	}, 3*time.Second, 50*time.Millisecond)
	assert.Equal(t, first.ID, active.Items[0].DeviceID)
	assert.Equal(t, "sim-peer", active.Items[0].PeerName)
	assert.Equal(t, "remote", active.Items[0].Type)
	assert.Nil(t, active.Items[0].EndedAt)
	b.expect(http.StatusOK, http.MethodGet, apiPrefix+"/sessions?device_id="+first.ID, nil, &active)
	require.Len(t, active.Items, 1)

	var summary struct {
		Sessions struct {
			Active int `json:"active"`
		} `json:"sessions"`
	}
	b.expect(http.StatusOK, http.MethodGet, apiPrefix+"/stats/summary", nil, &summary)
	assert.Equal(t, 1, summary.Sessions.Active)

	ended := events.next(t, "session.ended", 15*time.Second)
	assert.Contains(t, ended, `"`+first.ID+`"`)
	stopSim()
	assert.EqualValues(t, 1, (<-simDone).Sessions)

	var sstats struct {
		PerDay []struct {
			Count int `json:"count"`
		} `json:"per_day"`
	}
	b.expect(http.StatusOK, http.MethodGet, apiPrefix+"/sessions/stats?range=7d", nil, &sstats)
	total := 0
	for _, d := range sstats.PerDay {
		total += d.Count
	}
	assert.Equal(t, 1, total)
	b.expect(http.StatusOK, http.MethodGet, apiPrefix+"/stats/summary", nil, &summary)
	assert.Zero(t, summary.Sessions.Active)

	// The app's snapshotter waits before its first snapshot, so take one now.
	pool, err := store.Open(ctx, dbURL)
	require.NoError(t, err)
	defer pool.Close()
	var serverID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM servers LIMIT 1`).Scan(&serverID))
	snap := &stats.Snapshotter{Pool: pool, Online: func(string) bool { return true }}
	require.NoError(t, snap.Take(ctx, serverID))
	var history struct {
		Points []struct {
			Approved int `json:"approved"`
		} `json:"points"`
	}
	b.expect(http.StatusOK, http.MethodGet, apiPrefix+"/stats/history?range=24h", nil, &history)
	require.NotEmpty(t, history.Points)
	assert.Equal(t, 1, history.Points[len(history.Points)-1].Approved)

	// The root serves the built UI's index.html, or the placeholder while no
	// UI is built in.
	resp, err := b.client.Get(publicURL + "/")
	require.NoError(t, err)
	page, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	if ui, built := web.Assets(); built {
		index, err := fs.ReadFile(ui, "index.html")
		require.NoError(t, err)
		assert.Equal(t, "text/html; charset=utf-8", resp.Header.Get("Content-Type"))
		// Ruling F5: the page carries this response's style nonce in place
		// of the build's placeholder, and so does its CSP.
		csp := resp.Header.Get("Content-Security-Policy")
		_, rest, found := strings.Cut(csp, "style-src 'self' 'nonce-")
		nonce, _, closed := strings.Cut(rest, "'")
		require.True(t, found && closed && nonce != "", "CSP %q", csp)
		assert.Equal(t, strings.ReplaceAll(string(index), "__FERRICADE_CSP_NONCE__", nonce), string(page))
	} else {
		assert.Equal(t, "text/plain; charset=utf-8", resp.Header.Get("Content-Type"))
		assert.Contains(t, string(page), "the web UI is not built into this binary")
	}

	// The admin listener also serves the client routes, for clients that use
	// an https API URL through the reverse proxy.
	var hb map[string]any
	b.expect(http.StatusOK, http.MethodPost, "/api/heartbeat",
		map[string]string{"id": "100000000", "uuid": base64.StdEncoding.EncodeToString([]byte("sim-100000000"))}, &hb)

	// Closing the app flushes the tracker: heartbeats reach last_seen_at.
	a.Close()
	check, err := store.Open(ctx, dbURL)
	require.NoError(t, err)
	defer check.Close()
	var beatAfterEnroll bool
	require.NoError(t, check.QueryRow(ctx,
		`SELECT last_seen_at > first_seen_at FROM devices WHERE rustdesk_id = '100000000'`).Scan(&beatAfterEnroll))
	assert.True(t, beatAfterEnroll, "the final flush stored the last heartbeat")
}

// eventStream is an open /events stream: its events, in order.
type eventStream struct {
	ch chan [2]string // event type, data
}

// openEvents subscribes to the admin event stream with the browser's session
// and ends the stream with ctx or the test.
func (b *browser) openEvents(ctx context.Context) *eventStream {
	b.t.Helper()
	ctx, cancel := context.WithCancel(ctx)
	b.t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.base+apiPrefix+"/events", nil)
	require.NoError(b.t, err)
	req.Header.Set("Origin", b.base)
	req.Header.Set("Accept", "text/event-stream")
	// The browser's client has a total timeout, which would cut a stream.
	resp, err := (&http.Client{Jar: b.client.Jar}).Do(req)
	require.NoError(b.t, err)
	require.Equal(b.t, http.StatusOK, resp.StatusCode)
	require.Equal(b.t, "text/event-stream", resp.Header.Get("Content-Type"))
	es := &eventStream{ch: make(chan [2]string, 64)}
	go func() {
		defer resp.Body.Close()
		defer close(es.ch)
		sc := bufio.NewScanner(resp.Body)
		var typ string
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				typ = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				select {
				case es.ch <- [2]string{typ, strings.TrimPrefix(line, "data: ")}:
				default:
				}
			}
		}
	}()
	return es
}

// next returns the data of the next event of the given type, skipping others.
func (es *eventStream) next(t *testing.T, typ string, wait time.Duration) string {
	t.Helper()
	timeout := time.After(wait)
	for {
		select {
		case ev, ok := <-es.ch:
			require.True(t, ok, "the event stream ended while waiting for %s", typ)
			if ev[0] == typ {
				return ev[1]
			}
		case <-timeout:
			require.FailNow(t, "timed out waiting for event "+typ)
		}
	}
}

func TestAdminRefusesHTTPPublicURL(t *testing.T) {
	u, err := url.Parse("http://admin.example.com")
	require.NoError(t, err)
	cfg := config.Config{
		DatabaseURL: "postgres://unused.invalid/ferricade",
		PublicURL:   u,
		SecretKey:   bytes.Repeat([]byte{7}, 32),
		DevInsecure: false,
	}
	_, err = app.New(context.Background(), cfg, quietLog())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "https")
}
