package clientapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/clientapi"
	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/contract"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/policies"
	"github.com/dottio123/ferricade/internal/sessions"
	"github.com/dottio123/ferricade/internal/sim"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

type setupState struct {
	id   uuid.UUID
	done bool
}

func (s setupState) ServerID() (uuid.UUID, bool) { return s.id, s.done }

func do(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// liveRoutes returns Routes backed by a real database with setup complete.
func liveRoutes(t *testing.T) http.Handler {
	t.Helper()
	h, _ := liveRoutesPool(t)
	return h
}

// liveRoutesPool is liveRoutes that also returns the database.
func liveRoutesPool(t *testing.T) (http.Handler, *pgxpool.Pool) {
	t.Helper()
	pool := store.NewTestDB(t)
	srv, err := db.New(pool).CreateServer(context.Background(), db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	svc := &devices.Service{Pool: pool, Beats: devices.NewTracker(time.Now), MaxPending: 100}
	return clientapi.Routes(clientapi.Deps{Devices: svc, Setup: setupState{srv.ID, true}}), pool
}

func TestHealthz(t *testing.T) {
	rec := do(clientapi.Routes(clientapi.Deps{Setup: setupState{}}), http.MethodGet, "/healthz", "")
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "ok", rec.Body.String())
}

func TestUnknownClientPath404(t *testing.T) {
	h := clientapi.Routes(clientapi.Deps{Setup: setupState{}})
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/audit/file"},
		{http.MethodGet, "/api/nope"},
		{http.MethodGet, "/api/heartbeat"}, // 405 is reported as 404
	} {
		rec := do(h, tc.method, tc.path, "")
		assert.Equal(t, http.StatusNotFound, rec.Code, tc.path)
		assert.JSONEq(t, `{"error":"not found"}`, rec.Body.String(), tc.path)
		assert.Equal(t, "application/json", rec.Header().Get("Content-Type"), tc.path)
	}
}

func TestHeartbeatBeforeSetup(t *testing.T) {
	pool := store.NewTestDB(t)
	svc := &devices.Service{Pool: pool, Beats: devices.NewTracker(time.Now), MaxPending: 10}
	h := clientapi.Routes(clientapi.Deps{Devices: svc, Setup: setupState{}})
	rec := do(h, http.MethodPost, "/api/heartbeat", `{"id":"123456789","uuid":"ZmFrZS11dWlk"}`)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{}`, rec.Body.String())
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT count(*) FROM devices`).Scan(&n))
	assert.Zero(t, n, "nothing stored before setup")

	// No validation beyond reading the body.
	rec = do(h, http.MethodPost, "/api/heartbeat", `{`)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{}`, rec.Body.String())
}

func TestHeartbeatSharesDeviceLookupAndPolicyChain(t *testing.T) {
	ctx := context.Background()
	pool := store.NewTestDB(t)
	srv, err := db.New(pool).CreateServer(ctx, db.CreateServerParams{Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com", PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="})
	require.NoError(t, err)
	var deviceID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO devices (server_id,rustdesk_id,uuid,state) VALUES ($1,'555','ZmFrZQ==','approved') RETURNING id`, srv.ID).Scan(&deviceID))
	_, err = pool.Exec(ctx, `UPDATE client_policy_settings SET push_enabled=true`)
	require.NoError(t, err)
	tracker := devices.NewTracker(time.Now)
	deviceService := &devices.Service{Pool: pool, Beats: tracker, MaxPending: 100}
	sessionService := &sessions.Service{Pool: pool}
	policyService := &policies.Service{Pool: pool}
	h := clientapi.Routes(clientapi.Deps{Devices: deviceService, Sessions: sessionService, Policies: policyService, Setup: setupState{srv.ID, true}})
	hb := wire.HeartbeatRequest{ID: "555", UUID: "ZmFrZQ==", Conns: []int32{}}
	expected, err := deviceService.Heartbeat(ctx, srv.ID, hb, netip.MustParseAddr("192.0.2.1"))
	require.NoError(t, err)
	expected.Disconnect, err = sessionService.SyncConns(ctx, srv.ID, hb.ID, hb.UUID, hb.Conns)
	require.NoError(t, err)
	expected.Strategy, expected.ModifiedAt, err = policyService.Strategy(ctx, srv.ID, hb.ID, hb.UUID, hb.ModifiedAt)
	require.NoError(t, err)
	wantBytes, err := json.Marshal(expected)
	require.NoError(t, err)
	wantBytes = append(wantBytes, '\n')
	_, err = pool.Exec(ctx, `UPDATE devices SET strategy_version_seen=NULL WHERE id=$1`, deviceID)
	require.NoError(t, err)
	before := pool.Stat().AcquireCount()
	rec := do(h, http.MethodPost, "/api/heartbeat", `{"id":"555","uuid":"ZmFrZQ==","conns":[]}`)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, wantBytes, rec.Body.Bytes(), "heartbeat response bytes match the existing service path")
	require.EqualValues(t, 4, pool.Stat().AcquireCount()-before, "heartbeat, conns sync and strategy share the identified device and policy chain")
	var stillThere uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM devices WHERE id=$1`, deviceID).Scan(&stillThere))
}

func TestSysinfoBeforeSetup(t *testing.T) {
	h := clientapi.Routes(clientapi.Deps{Setup: setupState{}})
	rec := do(h, http.MethodPost, "/api/sysinfo", `not json`)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "SYSINFO_UPDATED", rec.Body.String())
	assert.Contains(t, rec.Header().Get("Content-Type"), "text/plain")
}

func TestHeartbeatBadBody(t *testing.T) {
	h := liveRoutes(t)
	for _, body := range []string{`{`, `{"id":""}`, `{"id":"1"}`, `{"uuid":"x"}`, ``} {
		rec := do(h, http.MethodPost, "/api/heartbeat", body)
		assert.Equal(t, http.StatusBadRequest, rec.Code, body)
		assert.JSONEq(t, `{"error":"bad request"}`, rec.Body.String(), body)
	}
}

func TestSysinfoBadBody(t *testing.T) {
	h := liveRoutes(t)
	for _, body := range []string{`{`, `{"id":"1"}`, `{"uuid":"x","hostname":"h"}`} {
		rec := do(h, http.MethodPost, "/api/sysinfo", body)
		assert.Equal(t, http.StatusBadRequest, rec.Code, body)
		assert.JSONEq(t, `{"error":"bad request"}`, rec.Body.String(), body)
	}
}

func TestClientAPIFieldLimits(t *testing.T) {
	h, pool := liveRoutesPool(t)
	post := func(path string, body any) *httptest.ResponseRecorder {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		return do(h, http.MethodPost, path, string(raw))
	}
	conns := make([]int32, 256)
	for i := range conns {
		conns[i] = int32(i + 1)
	}
	rec := post("/api/heartbeat", map[string]any{"id": strings.Repeat("i", 64), "uuid": strings.Repeat("u", 128), "conns": conns})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = post("/api/sysinfo", map[string]any{"id": strings.Repeat("i", 64), "uuid": strings.Repeat("u", 128)})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	for _, tc := range []struct {
		path string
		body map[string]any
	}{
		{"/api/heartbeat", map[string]any{"id": strings.Repeat("i", 65), "uuid": "u"}},
		{"/api/heartbeat", map[string]any{"id": "i", "uuid": strings.Repeat("u", 129)}},
		{"/api/heartbeat", map[string]any{"id": "i", "uuid": "u", "conns": append(conns, 257)}},
		{"/api/sysinfo", map[string]any{"id": strings.Repeat("i", 65), "uuid": "u"}},
		{"/api/sysinfo", map[string]any{"id": "i", "uuid": strings.Repeat("u", 129)}},
	} {
		t.Run(tc.path+"/identity or conns over limit", func(t *testing.T) {
			before := pool.Stat().AcquireCount()
			rec := post(tc.path, tc.body)
			assert.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			assert.JSONEq(t, `{"error":"bad request"}`, rec.Body.String())
			assert.Equal(t, before, pool.Stat().AcquireCount(), "rejected request must not reach the database")
		})
	}
	for _, field := range []string{"version", "hostname", "os", "cpu", "memory", "username"} {
		body := map[string]any{"id": "sysinfo-limit", "uuid": "uuid-limit", field: strings.Repeat("s", 1025)}
		t.Run(field+" over limit", func(t *testing.T) {
			before := pool.Stat().AcquireCount()
			rec := post("/api/sysinfo", body)
			assert.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			assert.Equal(t, before, pool.Stat().AcquireCount(), "rejected request must not reach the database")
		})
	}
	for _, field := range []string{"version", "hostname", "os", "cpu", "memory", "username"} {
		body := map[string]any{"id": "sysinfo-limit", "uuid": "uuid-limit", field: strings.Repeat("s", 1024)}
		rec := post("/api/sysinfo", body)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
	presets := make(map[string]string, 64)
	for i := 0; i < 64; i++ {
		presets[fmt.Sprintf("preset-%02d", i)] = "v"
	}
	presetBody := map[string]any{"id": "preset-limit", "uuid": "uuid-limit"}
	for key, value := range presets {
		presetBody[key] = value
	}
	rec = post("/api/sysinfo", presetBody)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	maxPreset := map[string]any{"id": "preset-limit", "uuid": "uuid-limit", "preset-" + strings.Repeat("k", 1017): strings.Repeat("v", 1024)}
	rec = post("/api/sysinfo", maxPreset)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	presetBody["preset-extra"] = "v"
	before := pool.Stat().AcquireCount()
	rec = post("/api/sysinfo", presetBody)
	assert.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	assert.Equal(t, before, pool.Stat().AcquireCount(), "rejected request must not reach the database")
	presetBody = map[string]any{"id": "preset-limit", "uuid": "uuid-limit", "preset-long": strings.Repeat("v", 1025)}
	before = pool.Stat().AcquireCount()
	rec = post("/api/sysinfo", presetBody)
	assert.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	assert.Equal(t, before, pool.Stat().AcquireCount(), "rejected request must not reach the database")
	presetBody = map[string]any{"id": "preset-limit", "uuid": "uuid-limit", "preset-" + strings.Repeat("k", 1018): "v"}
	before = pool.Stat().AcquireCount()
	rec = post("/api/sysinfo", presetBody)
	assert.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	assert.Equal(t, before, pool.Stat().AcquireCount(), "rejected request must not reach the database")
}

func TestBodyLimit(t *testing.T) {
	big := `{"id":"1","uuid":"x","pad":"` + strings.Repeat("a", 65<<10) + `"}`
	for _, setup := range []bool{true, false} {
		h := clientapi.Routes(clientapi.Deps{Setup: setupState{done: setup}})
		for _, path := range []string{"/api/heartbeat", "/api/sysinfo", "/api/audit/conn"} {
			rec := do(h, http.MethodPost, path, big)
			assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, path)
			assert.JSONEq(t, `{"error":"body too large"}`, rec.Body.String(), path)
		}
	}
}

func TestRateLimitedClient(t *testing.T) {
	h := clientapi.Routes(clientapi.Deps{Setup: setupState{}})
	var limited int
	for i := 0; i < 60; i++ {
		rec := do(h, http.MethodPost, "/api/heartbeat", `{}`)
		if rec.Code == http.StatusTooManyRequests {
			limited++
			assert.JSONEq(t, `{"error":"rate limited"}`, rec.Body.String())
		}
	}
	assert.Positive(t, limited, "burst of 40 exceeded")
	assert.LessOrEqual(t, limited, 20)
}

func TestEnrollAndSysinfoStored(t *testing.T) {
	h := liveRoutes(t)
	rec := do(h, http.MethodPost, "/api/heartbeat", `{"id":"555","uuid":"ZmFrZQ=="}`)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"sysinfo":true}`, rec.Body.String())
	rec = do(h, http.MethodPost, "/api/sysinfo", `{"id":"555","uuid":"ZmFrZQ==","hostname":"pc1","os":"linux"}`)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "SYSINFO_UPDATED", rec.Body.String())
	rec = do(h, http.MethodPost, "/api/heartbeat", `{"id":"555","uuid":"ZmFrZQ=="}`)
	assert.JSONEq(t, `{}`, rec.Body.String())
}

func TestDerivedFixturesReplay(t *testing.T) {
	h := liveRoutes(t)
	fixtures, err := contract.LoadDir(filepath.Join("..", "..", "testdata", "contracts", "derived-1.5.0"))
	require.NoError(t, err)
	var replayed int
	for _, f := range fixtures {
		if f.Path != "/api/heartbeat" && f.Path != "/api/sysinfo" {
			continue
		}
		replayed++
		rec := do(h, f.Method, f.Path, string(f.Body))
		require.Equal(t, http.StatusOK, rec.Code, "%s %s: %s", f.Method, f.Path, rec.Body.String())
		if f.ResponseText != "" {
			assert.Equal(t, f.ResponseText, rec.Body.String())
		}
	}
	assert.Equal(t, 3, replayed, "heartbeat, heartbeat-with-conns, sysinfo")
}

func TestSimulatorEnrollsPending(t *testing.T) {
	pool := store.NewTestDB(t)
	q := db.New(pool)
	srv, err := q.CreateServer(context.Background(), db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	svc := &devices.Service{Pool: pool, Beats: devices.NewTracker(time.Now), MaxPending: 100}
	ts := httptest.NewServer(clientapi.Routes(clientapi.Deps{Devices: svc, Setup: setupState{srv.ID, true}}))
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	stats, err := sim.Run(ctx, sim.Options{API: ts.URL, Devices: 3, Interval: 50 * time.Millisecond})
	require.NoError(t, err)
	assert.Zero(t, stats.Errors)
	assert.Positive(t, stats.Heartbeats)

	n, err := q.CountPendingDevices(context.Background(), srv.ID)
	require.NoError(t, err)
	assert.EqualValues(t, 3, n)
}

func TestTrustedProxyXFFIsUsedForEnrollmentAudit(t *testing.T) {
	pool := store.NewTestDB(t)
	srv, err := db.New(pool).CreateServer(context.Background(), db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	svc := &devices.Service{Pool: pool, Beats: devices.NewTracker(time.Now), MaxPending: 100}
	h := clientapi.Routes(clientapi.Deps{
		Devices: svc, Setup: setupState{srv.ID, true},
		Trusted: []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}, // httptest peer is 192.0.2.1
	})
	req := httptest.NewRequest(http.MethodPost, "/api/heartbeat", strings.NewReader(`{"id":"777","uuid":"ZmFrZQ=="}`))
	req.Header.Set("X-Forwarded-For", "198.51.100.77")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var ip netip.Addr
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT actor_ip FROM audit_events WHERE action = 'device.enrolled'`).Scan(&ip))
	assert.Equal(t, netip.MustParseAddr("198.51.100.77"), ip)
}

// A preset password the client sends is not stored; the other presets are.
func TestSysinfoDoesNotStorePresetPassword(t *testing.T) {
	h, pool := liveRoutesPool(t)
	require.Equal(t, http.StatusOK, do(h, http.MethodPost, "/api/heartbeat", `{"id":"555","uuid":"ZmFrZQ=="}`).Code)
	rec := do(h, http.MethodPost, "/api/sysinfo", `{"id":"555","uuid":"ZmFrZQ==","hostname":"pc1",`+
		`"preset-address-book-name":"Ops","preset-address-book-password":"s3cret"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var presets string
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT presets::text FROM devices WHERE rustdesk_id = '555'`).Scan(&presets))
	assert.JSONEq(t, `{"preset-address-book-name":"Ops"}`, presets)
	assert.NotContains(t, presets, "s3cret")
}

// NUL in any string of a client body (Postgres text cannot hold it) is a
// 400, before anything is stored.
func TestClientBodyWithNULIsBadRequest(t *testing.T) {
	h, pool := liveRoutesPool(t)
	for _, tc := range []struct{ path, body string }{
		{"/api/heartbeat", `{"id":"55\u00005","uuid":"ZmFrZQ=="}`},
		{"/api/heartbeat", `{"id":"555","uuid":"ZmF\u0000rZQ=="}`},
		{"/api/heartbeat", `{"id":"555","uuid":"ZmFrZQ==","note":"\u0000"}`},
		{"/api/heartbeat", `{"id":"555","uuid":"ZmFrZQ==","x\u0000":1}`},
		{"/api/sysinfo", `{"id":"55\u00005","uuid":"ZmFrZQ=="}`},
		{"/api/sysinfo", `{"id":"555","uuid":"ZmFrZQ==","hostname":"pc\u00001"}`},
		{"/api/sysinfo", `{"id":"555","uuid":"ZmFrZQ==","os":"linux","cpu":"\u0000"}`},
		{"/api/sysinfo", `{"id":"555","uuid":"ZmFrZQ==","preset-address-book-name":"O\u0000ps"}`},
		{"/api/sysinfo", `{"id":"555","uuid":"ZmFrZQ==","preset-a\u0000":"x"}`},
		{"/api/sysinfo", `{"id":"555","uuid":"ZmFrZQ==","extra":["\u0000"]}`},
	} {
		rec := do(h, http.MethodPost, tc.path, tc.body)
		assert.Equal(t, http.StatusBadRequest, rec.Code, tc.body)
		assert.JSONEq(t, `{"error":"bad request"}`, rec.Body.String(), tc.body)
	}
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT count(*) FROM devices`).Scan(&n))
	assert.Zero(t, n)

	// An escaped backslash before "u0000" is ordinary text.
	rec := do(h, http.MethodPost, "/api/heartbeat", `{"id":"555","uuid":"ZmFrZQ==","note":"\\u0000"}`)
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

// auditRoutes returns Routes with a sessions service whose clock reads *now,
// and the fixtures' device enrolled (pending) by a heartbeat.
func auditRoutes(t *testing.T, now *time.Time) (http.Handler, *pgxpool.Pool) {
	t.Helper()
	pool := store.NewTestDB(t)
	srv, err := db.New(pool).CreateServer(context.Background(), db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	h := clientapi.Routes(clientapi.Deps{
		Devices:  &devices.Service{Pool: pool, Beats: devices.NewTracker(time.Now), MaxPending: 100},
		Sessions: &sessions.Service{Pool: pool, Now: func() time.Time { return *now }},
		Setup:    setupState{srv.ID, true},
		Log:      slog.New(slog.NewTextHandler(io.Discard, nil)), // refused posts are expected here
	})
	require.Equal(t, http.StatusOK, do(h, http.MethodPost, "/api/heartbeat", `{"id":"123456789","uuid":"ZmFrZS11dWlk"}`).Code)
	return h, pool
}

func auditFixtures(t *testing.T) map[string]contract.Fixture {
	t.Helper()
	fixtures, err := contract.LoadDir(filepath.Join("..", "..", "testdata", "contracts", "derived-1.5.0"))
	require.NoError(t, err)
	out := map[string]contract.Fixture{}
	for _, f := range fixtures {
		if f.Path == "/api/audit/conn" {
			require.True(t, f.ResponseEmpty, f.Path)
			var a struct{ Action string }
			require.NoError(t, json.Unmarshal(f.Body, &a))
			if a.Action == "" {
				a.Action = "auth"
			}
			out[a.Action] = f
		}
	}
	require.Len(t, out, 3, "new, auth and close")
	return out
}

func countRows(t *testing.T, pool *pgxpool.Pool, query string) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), query).Scan(&n))
	return n
}

func TestAuditConnRoute(t *testing.T) {
	fx := auditFixtures(t)

	t.Run("fixtures make one closed session", func(t *testing.T) {
		now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
		h, pool := auditRoutes(t, &now)
		_, err := pool.Exec(context.Background(), `UPDATE devices SET state = 'approved' WHERE rustdesk_id = '123456789'`)
		require.NoError(t, err)
		for _, action := range []string{"new", "auth", "close"} {
			f := fx[action]
			rec := do(h, f.Method, f.Path, string(f.Body))
			require.Equal(t, http.StatusOK, rec.Code, "%s: %s", action, rec.Body.String())
			assert.Empty(t, rec.Body.Bytes(), action)
			now = now.Add(time.Second)
		}
		assert.Equal(t, 1, countRows(t, pool,
			`SELECT count(*) FROM remote_sessions WHERE peer_rustdesk_id = '987654321' AND end_reason = 'closed'`))
	})

	t.Run("pending device cannot write sessions", func(t *testing.T) {
		now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
		h, pool := auditRoutes(t, &now)
		f := fx["new"]
		rec := do(h, f.Method, f.Path, string(f.Body))
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Zero(t, countRows(t, pool, `SELECT count(*) FROM remote_sessions`))
		assert.Zero(t, countRows(t, pool, `SELECT count(*) FROM seen_nonces`))
		rec = do(h, http.MethodPost, "/api/heartbeat", `{"id":"123456789","uuid":"ZmFrZS11dWlk","conns":[3]}`)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Zero(t, countRows(t, pool, `SELECT count(*) FROM remote_sessions`))
		assert.Zero(t, countRows(t, pool, `SELECT count(*) FROM seen_nonces`))
	})

	t.Run("bad bodies", func(t *testing.T) {
		now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
		h, pool := auditRoutes(t, &now)
		for _, body := range []string{
			`{`, ``,
			`{"uuid":"ZmFrZS11dWlk","conn_id":3,"nonce":"n1","action":"new"}`,
			`{"id":"123456789","conn_id":3,"nonce":"n1","action":"new"}`,
			`{"id":"123456789","uuid":"ZmFrZS11dWlk","conn_id":3,"action":"new"}`,
			`{"id":"123456789","uuid":"ZmFrZS11dWlk","conn_id":3,"nonce":"` + strings.Repeat("n", 129) + `","action":"new"}`,
			`{"id":"123456789","uuid":"ZmFrZS11dWlk","conn_id":3,"nonce":"n1","peer":["98765\u00004321","bob"]}`,
			`{"id":"123456789","uuid":"ZmFrZS11dWlk","conn_id":3,"nonce":"n1","peer":["987654321","b\u0000ob"]}`,
			`{"id":"123456789","uuid":"ZmFrZS11dWlk","conn_id":3,"nonce":"n1","session_id":-1}`,
			`{"id":"123456789","uuid":"ZmFrZS11dWlk","conn_id":4294967296,"nonce":"n1"}`,
		} {
			rec := do(h, http.MethodPost, "/api/audit/conn", body)
			assert.Equal(t, http.StatusBadRequest, rec.Code, body)
			assert.JSONEq(t, `{"error":"bad request"}`, rec.Body.String(), body)
		}
		assert.Zero(t, countRows(t, pool, `SELECT count(*) FROM remote_sessions`))
		assert.Zero(t, countRows(t, pool, `SELECT count(*) FROM seen_nonces`))

		// A 128-byte nonce is accepted.
		_, err := pool.Exec(context.Background(), `UPDATE devices SET state = 'approved' WHERE rustdesk_id = '123456789'`)
		require.NoError(t, err)
		rec := do(h, http.MethodPost, "/api/audit/conn",
			`{"id":"123456789","uuid":"ZmFrZS11dWlk","conn_id":3,"nonce":"`+strings.Repeat("n", 128)+`","action":"new"}`)
		assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM remote_sessions`))
	})

	t.Run("before setup", func(t *testing.T) {
		pool := store.NewTestDB(t)
		h := clientapi.Routes(clientapi.Deps{
			Devices:  &devices.Service{Pool: pool, Beats: devices.NewTracker(time.Now), MaxPending: 100},
			Sessions: &sessions.Service{Pool: pool},
			Setup:    setupState{},
		})
		f := fx["new"]
		rec := do(h, f.Method, f.Path, string(f.Body))
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Empty(t, rec.Body.Bytes())
		assert.Zero(t, countRows(t, pool, `SELECT count(*) FROM remote_sessions`))
		assert.Zero(t, countRows(t, pool, `SELECT count(*) FROM seen_nonces`))
	})

	t.Run("without a sessions service", func(t *testing.T) {
		h, pool := liveRoutesPool(t)
		require.Equal(t, http.StatusOK, do(h, http.MethodPost, "/api/heartbeat", `{"id":"123456789","uuid":"ZmFrZS11dWlk"}`).Code)
		f := fx["new"]
		rec := do(h, f.Method, f.Path, string(f.Body))
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Empty(t, rec.Body.Bytes())
		assert.Zero(t, countRows(t, pool, `SELECT count(*) FROM remote_sessions`))
	})

	t.Run("heartbeat closes a stale session", func(t *testing.T) {
		start := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
		now := start
		h, pool := auditRoutes(t, &now)
		_, err := pool.Exec(context.Background(), `UPDATE devices SET state = 'approved' WHERE rustdesk_id = '123456789'`)
		require.NoError(t, err)
		f := fx["new"]
		require.Equal(t, http.StatusOK, do(h, f.Method, f.Path, string(f.Body)).Code)
		const open = `SELECT count(*) FROM remote_sessions WHERE ended_at IS NULL`
		require.Equal(t, 1, countRows(t, pool, open))

		now = start.Add(30 * time.Second)
		rec := do(h, http.MethodPost, "/api/heartbeat", `{"id":"123456789","uuid":"ZmFrZS11dWlk","conns":[]}`)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, 1, countRows(t, pool, open))

		now = start.Add(61 * time.Second)
		rec = do(h, http.MethodPost, "/api/heartbeat", `{"id":"123456789","uuid":"ZmFrZS11dWlk","conns":[]}`)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Zero(t, countRows(t, pool, open))
		assert.Equal(t, 1, countRows(t, pool,
			`SELECT count(*) FROM remote_sessions WHERE end_reason = 'stale' AND ended_at = conn_seen_at`))
	})
}
