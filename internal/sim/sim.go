// Package sim simulates RustDesk devices reporting to a client API server,
// for contract replay and load tests.
package sim

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	mrand "math/rand/v2"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dottio123/ferricade/internal/clientapi/wire"
)

type Options struct {
	API                 string        // base URL, e.g. http://localhost:21114
	Devices             int           // number of simulated devices
	Interval            time.Duration // heartbeat interval; default 15s
	StopAfterHeartbeats int64         // return after this many successful heartbeats; zero runs until ctx ends
	IDBase              int           // first device ID; default 100000000
	Version             string        // client version; default "1.5.0"

	// SessionEvery, when positive, makes each device open a simulated remote
	// session after that pause (the first at its own random offset), reported as the
	// three audit/conn records a real client posts. SessionLength is how long
	// each stays open; default 30s.
	SessionEvery  time.Duration
	SessionLength time.Duration
}

type Stats struct {
	Heartbeats  int64         `json:"heartbeats"`
	Sysinfos    int64         `json:"sysinfos"`
	Errors      int64         `json:"errors"`
	Disconnects int64         `json:"disconnects"`
	Sessions    int64         `json:"sessions"` // sessions opened
	Strategies  int64         `json:"strategies"`
	P50         time.Duration `json:"p50"`
	P99         time.Duration `json:"p99"`
}

type runner struct {
	o       Options
	client  *http.Client
	stats   Stats
	mu      sync.Mutex
	latency []time.Duration
	cancel  context.CancelFunc
}

// Run simulates o.Devices devices until ctx ends and returns what happened.
func Run(ctx context.Context, o Options) (Stats, error) {
	if o.API == "" {
		return Stats{}, errors.New("sim: API is required")
	}
	if o.Devices < 1 {
		return Stats{}, errors.New("sim: Devices must be at least 1")
	}
	if o.Interval <= 0 {
		o.Interval = 15 * time.Second
	}
	if o.IDBase == 0 {
		o.IDBase = 100000000
	}
	if o.Version == "" {
		o.Version = "1.5.0"
	}
	if o.SessionLength <= 0 {
		o.SessionLength = 30 * time.Second
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	r := &runner{o: o, client: &http.Client{Timeout: 10 * time.Second}, cancel: cancel}

	var wg sync.WaitGroup
	for i := 0; i < o.Devices; i++ {
		wg.Add(1)
		d := &deviceState{id: strconv.Itoa(o.IDBase + i)}
		d.uuid = base64.StdEncoding.EncodeToString([]byte("sim-" + d.id))
		go func(i int) {
			defer wg.Done()
			r.device(runCtx, i, d)
		}(i)
		if o.SessionEvery > 0 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				r.sessions(runCtx, d)
			}()
		}
	}
	wg.Wait()

	sort.Slice(r.latency, func(a, b int) bool { return r.latency[a] < r.latency[b] })
	if n := len(r.latency); n > 0 {
		r.stats.P50 = r.latency[n*50/100]
		r.stats.P99 = r.latency[n*99/100]
	}
	return r.stats, nil
}

// deviceState is what a device's heartbeat loop and its session loop share.
type deviceState struct {
	id, uuid   string
	conn       atomic.Int32 // the open session's conn_id, or 0
	modifiedAt int64
}

func (r *runner) device(ctx context.Context, i int, d *deviceState) {
	id, uuid := d.id, d.uuid
	// Spread starts evenly over the first interval.
	if !sleep(ctx, r.o.Interval*time.Duration(i)/time.Duration(r.o.Devices)) {
		return
	}
	needSysinfo := true
	for {
		if needSysinfo {
			ok := r.sysinfo(ctx, id, uuid)
			if ctx.Err() != nil {
				return
			}
			needSysinfo = !ok
		}
		if r.heartbeat(ctx, d) {
			needSysinfo = true
		}
		if !sleep(ctx, r.o.Interval) {
			return
		}
	}
}

func (r *runner) sysinfo(ctx context.Context, id, uuid string) bool {
	body, _ := json.Marshal(wire.SysinfoRequest{
		ID: id, UUID: uuid, Version: r.o.Version,
		Hostname: "sim-" + id, OS: "linux / Simulated", CPU: "sim, 1GHz, 1/1 cores", Memory: "1GB",
	})
	reply, _, err := r.post(ctx, "/api/sysinfo", body)
	if err != nil || string(reply) != wire.SysinfoUpdated {
		r.fail(ctx)
		return false
	}
	atomic.AddInt64(&r.stats.Sysinfos, 1)
	return true
}

// heartbeat reports whether the server asked for sysinfo again.
func (r *runner) heartbeat(ctx context.Context, d *deviceState) bool {
	hb := wire.HeartbeatRequest{ID: d.id, UUID: d.uuid, Ver: versionNumber(r.o.Version), ModifiedAt: d.modifiedAt}
	if c := d.conn.Load(); c != 0 {
		hb.Conns = []int32{c}
	}
	body, _ := json.Marshal(hb)
	reply, took, err := r.post(ctx, "/api/heartbeat", body)
	var resp wire.HeartbeatResponse
	if err == nil {
		err = json.Unmarshal(reply, &resp)
	}
	if err != nil {
		r.fail(ctx)
		return false
	}
	atomic.AddInt64(&r.stats.Heartbeats, 1)
	if resp.ModifiedAt != nil {
		d.modifiedAt = *resp.ModifiedAt
	}
	if resp.Strategy != nil {
		atomic.AddInt64(&r.stats.Strategies, 1)
	}
	if r.o.StopAfterHeartbeats > 0 && atomic.LoadInt64(&r.stats.Heartbeats) >= r.o.StopAfterHeartbeats {
		r.cancel()
	}
	atomic.AddInt64(&r.stats.Disconnects, int64(len(resp.Disconnect)))
	r.mu.Lock()
	r.latency = append(r.latency, took)
	r.mu.Unlock()
	return resp.Sysinfo
}

// sessions opens a simulated session, keeps it open for SessionLength, and
// pauses SessionEvery before the next; the first starts at a random offset.
func (r *runner) sessions(ctx context.Context, d *deviceState) {
	if !sleep(ctx, time.Duration(mrand.Int64N(int64(r.o.SessionEvery)))) {
		return
	}
	for {
		connID := mrand.Int32N(1<<30) + 1
		typ, primary := 0, 1
		sessionID := mrand.Uint64N(math.MaxUint64) + 1
		rec := func(ctx context.Context, c wire.ConnAudit) bool {
			c.ID, c.UUID, c.ConnID, c.Nonce = d.id, d.uuid, connID, nonce()
			body, _ := json.Marshal(c)
			if _, _, err := r.post(ctx, "/api/audit/conn", body); err != nil {
				r.fail(ctx)
				return false
			}
			return true
		}
		if rec(ctx, wire.ConnAudit{Action: wire.ConnActionNew, IP: "10.0.0.9"}) &&
			rec(ctx, wire.ConnAudit{SessionID: sessionID, Peer: []string{"900000000", "sim-peer"}, Type: &typ, PrimaryAuth: &primary}) {
			atomic.AddInt64(&r.stats.Sessions, 1)
			d.conn.Store(connID)
			ok := sleep(ctx, r.o.SessionLength)
			d.conn.Store(0)
			closeCtx := ctx
			if !ok {
				// The run ended with the session open: close it anyway.
				var cancel context.CancelFunc
				closeCtx, cancel = context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
			}
			rec(closeCtx, wire.ConnAudit{SessionID: sessionID, Action: wire.ConnActionClose})
			if !ok {
				return
			}
		}
		if !sleep(ctx, r.o.SessionEvery) {
			return
		}
	}
}

func nonce() string {
	var b [12]byte
	_, _ = crand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func (r *runner) post(ctx context.Context, path string, body []byte) ([]byte, time.Duration, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.o.API+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	start := time.Now()
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	reply, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	took := time.Since(start)
	if err != nil {
		return nil, took, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, took, fmt.Errorf("%s: HTTP %d", path, resp.StatusCode)
	}
	return reply, took, nil
}

// fail counts an error unless it was caused by the run ending.
func (r *runner) fail(ctx context.Context) {
	if ctx.Err() == nil {
		atomic.AddInt64(&r.stats.Errors, 1)
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// versionNumber mirrors hbb_common::get_version_number: "1.5.0" → 1005000.
func versionNumber(v string) int64 {
	var n, last int64
	for _, part := range bytes.Split([]byte(v), []byte(".")) {
		last, _ = strconv.ParseInt(string(part), 10, 64)
		n = n*1000 + last
	}
	return n - last + last*10
}
