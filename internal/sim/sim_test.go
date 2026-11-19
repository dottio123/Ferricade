package sim_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/sim"
)

func run(t *testing.T, h http.HandlerFunc, devices int, d time.Duration) sim.Stats {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	st, err := sim.Run(ctx, sim.Options{API: srv.URL, Devices: devices, Interval: 50 * time.Millisecond, IDBase: 100000000})
	require.NoError(t, err)
	return st
}

func TestSimSendsSysinfoThenHeartbeats(t *testing.T) {
	var mu sync.Mutex
	ids := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/sysinfo":
			s, err := wire.ParseSysinfo(mustRead(r))
			if err == nil && s.ID != "" && s.UUID != "" && s.Version == "1.5.0" {
				_, _ = w.Write([]byte(wire.SysinfoUpdated))
				return
			}
			w.WriteHeader(400)
		case "/api/heartbeat":
			var hb wire.HeartbeatRequest
			if json.Unmarshal(mustRead(r), &hb) != nil || hb.Ver != 1005000 {
				w.WriteHeader(400)
				return
			}
			mu.Lock()
			ids[hb.ID] = true
			mu.Unlock()
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	started := time.Now()
	st, err := sim.Run(ctx, sim.Options{API: srv.URL, Devices: 3, Interval: 50 * time.Millisecond, IDBase: 100000000, StopAfterHeartbeats: 9})
	require.NoError(t, err)
	assert.EqualValues(t, 3, st.Sysinfos)
	assert.GreaterOrEqual(t, st.Heartbeats, int64(9))
	assert.LessOrEqual(t, st.Heartbeats, int64(11))
	assert.GreaterOrEqual(t, time.Since(started), 2*50*time.Millisecond)
	assert.Zero(t, st.Errors)
	assert.Len(t, ids, 3)
	assert.True(t, ids["100000000"])
}

func TestSimStopsAfterSuccessfulHeartbeats(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/sysinfo" {
			_, _ = w.Write([]byte(wire.SysinfoUpdated))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started := time.Now()
	st, err := sim.Run(ctx, sim.Options{API: srv.URL, Devices: 3, Interval: 20 * time.Millisecond, StopAfterHeartbeats: 4})
	require.NoError(t, err)
	assert.GreaterOrEqual(t, st.Heartbeats, int64(4))
	assert.LessOrEqual(t, st.Heartbeats, int64(6))
	assert.Less(t, time.Since(started), time.Second)
}

func TestSimReplaysStrategyVersion(t *testing.T) {
	var mu sync.Mutex
	var reported []int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/sysinfo" {
			_, _ = w.Write([]byte(wire.SysinfoUpdated))
			return
		}
		var hb wire.HeartbeatRequest
		_ = json.Unmarshal(mustRead(r), &hb)
		mu.Lock()
		reported = append(reported, hb.ModifiedAt)
		mu.Unlock()
		_, _ = w.Write([]byte(`{"modified_at":12345,"strategy":{"config_options":{"enable-file-transfer":"N"}}}`))
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := sim.Run(ctx, sim.Options{API: srv.URL, Devices: 1, Interval: 20 * time.Millisecond, StopAfterHeartbeats: 2})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(reported), 2)
	require.Equal(t, int64(0), reported[0])
	require.Equal(t, int64(12345), reported[1])
	require.EqualValues(t, 2, st.Strategies)
}

func TestSimResendsSysinfoOnRequest(t *testing.T) {
	var mu sync.Mutex
	asked := map[string]bool{}
	st := run(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/sysinfo" {
			_, _ = w.Write([]byte(wire.SysinfoUpdated))
			return
		}
		var hb wire.HeartbeatRequest
		_ = json.Unmarshal(mustRead(r), &hb)
		mu.Lock()
		first := !asked[hb.ID]
		asked[hb.ID] = true
		mu.Unlock()
		if first {
			_, _ = w.Write([]byte(`{"sysinfo":true}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}, 3, 300*time.Millisecond)
	assert.EqualValues(t, 6, st.Sysinfos)
}

func TestSimCountsDisconnects(t *testing.T) {
	st := run(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/sysinfo" {
			_, _ = w.Write([]byte(wire.SysinfoUpdated))
			return
		}
		_, _ = w.Write([]byte(`{"disconnect":[1,2]}`))
	}, 1, 120*time.Millisecond)
	assert.GreaterOrEqual(t, st.Disconnects, int64(2))
}

func TestSimCountsErrors(t *testing.T) {
	st := run(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }, 2, 150*time.Millisecond)
	assert.Positive(t, st.Errors)
}

func TestSimRejectsBadOptions(t *testing.T) {
	_, err := sim.Run(context.Background(), sim.Options{API: "", Devices: 1})
	require.Error(t, err)
	_, err = sim.Run(context.Background(), sim.Options{API: "http://x", Devices: 0})
	require.Error(t, err)
}

func mustRead(r *http.Request) []byte {
	b, _ := io.ReadAll(r.Body)
	return b
}

func TestSimSessions(t *testing.T) {
	var mu sync.Mutex
	audits := map[string][]wire.ConnAudit{} // by device
	conns := map[string][]int32{}           // device -> conns of heartbeats, in order
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/sysinfo":
			_, _ = w.Write([]byte(wire.SysinfoUpdated))
		case "/api/heartbeat":
			var hb wire.HeartbeatRequest
			_ = json.Unmarshal(mustRead(r), &hb)
			mu.Lock()
			c := int32(0)
			if len(hb.Conns) > 0 {
				c = hb.Conns[0]
			}
			conns[hb.ID] = append(conns[hb.ID], c)
			mu.Unlock()
			_, _ = w.Write([]byte(`{}`))
		case "/api/audit/conn":
			var a wire.ConnAudit
			_ = json.Unmarshal(mustRead(r), &a)
			mu.Lock()
			audits[a.ID] = append(audits[a.ID], a)
			mu.Unlock()
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	st, err := sim.Run(ctx, sim.Options{
		API: srv.URL, Devices: 2, Interval: 20 * time.Millisecond, IDBase: 100000000,
		SessionEvery: 100 * time.Millisecond, SessionLength: 150 * time.Millisecond,
	})
	require.NoError(t, err)
	assert.Zero(t, st.Errors)
	assert.GreaterOrEqual(t, st.Sessions, int64(2))

	mu.Lock()
	defer mu.Unlock()
	require.Len(t, audits, 2)
	for id, list := range audits {
		require.GreaterOrEqual(t, len(list), 3, id)
		first := list[:3]
		assert.Equal(t, wire.ConnActionNew, first[0].Action)
		assert.NotEmpty(t, first[0].IP)
		assert.Equal(t, []string{"900000000", "sim-peer"}, first[1].Peer)
		require.NotNil(t, first[1].Type)
		assert.Zero(t, *first[1].Type)
		assert.Equal(t, wire.ConnActionClose, first[2].Action)
		assert.Empty(t, first[0].Peer, "new carries the ip and no peer")
		assert.NotZero(t, first[1].SessionID)
		assert.Equal(t, first[1].SessionID, first[2].SessionID)
		require.NotNil(t, first[1].PrimaryAuth)
		assert.Equal(t, 1, *first[1].PrimaryAuth)
		nonces := map[string]bool{}
		for _, a := range first {
			assert.Equal(t, first[0].ConnID, a.ConnID)
			assert.NotEmpty(t, a.UUID)
			assert.NotEmpty(t, a.Nonce)
			nonces[a.Nonce] = true
		}
		assert.Len(t, nonces, 3, "a fresh nonce per record")
		assert.Contains(t, conns[id], first[0].ConnID, "heartbeats carry the open session")
		assert.Contains(t, conns[id], int32(0), "and stop carrying it after close")
	}
}

func TestSimClosesOpenSessionOnCancel(t *testing.T) {
	var mu sync.Mutex
	var actions []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/sysinfo":
			_, _ = w.Write([]byte(wire.SysinfoUpdated))
		case "/api/audit/conn":
			var a wire.ConnAudit
			_ = json.Unmarshal(mustRead(r), &a)
			mu.Lock()
			actions = append(actions, a.Action)
			mu.Unlock()
			_, _ = w.Write([]byte(`{}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	st, err := sim.Run(ctx, sim.Options{
		API: srv.URL, Devices: 1, Interval: 20 * time.Millisecond,
		SessionEvery: 50 * time.Millisecond, SessionLength: time.Hour,
	})
	require.NoError(t, err)
	require.EqualValues(t, 1, st.Sessions)
	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, []string{wire.ConnActionNew, "", wire.ConnActionClose}, actions)
}
