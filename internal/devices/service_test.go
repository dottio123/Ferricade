package devices_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

var (
	clientIP = netip.MustParseAddr("198.51.100.9")
	t0       = time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
)

const (
	uuidA = "dXVpZC1h" // base64 "uuid-a"
	uuidB = "dXVpZC1i" // base64 "uuid-b"
)

type beat struct {
	id    string
	conns []int32
}

type fakeBeater struct {
	mu    sync.Mutex
	beats []beat
}

func (f *fakeBeater) Beat(id string, conns []int32) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.beats = append(f.beats, beat{id, conns})
}

func (f *fakeBeater) got() []beat {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]beat(nil), f.beats...)
}

type fixture struct {
	pool     *pgxpool.Pool
	svc      *devices.Service
	beats    *fakeBeater
	serverID uuid.UUID
	now      time.Time
}

func newFixture(t *testing.T, maxPending int) *fixture {
	t.Helper()
	pool := store.NewTestDB(t)
	srv, err := db.New(pool).CreateServer(context.Background(), db.CreateServerParams{
		Name: "lab", IDHost: "rd.example.com", RelayHost: "rd.example.com",
		PublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	})
	require.NoError(t, err)
	f := &fixture{pool: pool, beats: &fakeBeater{}, serverID: srv.ID, now: t0}
	f.svc = &devices.Service{Pool: pool, Beats: f.beats, MaxPending: maxPending, Now: func() time.Time { return f.now }}
	return f
}

func (f *fixture) heartbeat(t *testing.T, id, uid string, conns ...int32) wire.HeartbeatResponse {
	t.Helper()
	resp, err := f.svc.Heartbeat(context.Background(), f.serverID,
		wire.HeartbeatRequest{ID: id, UUID: uid, Ver: 1, Conns: conns}, clientIP)
	require.NoError(t, err)
	return resp
}

func (f *fixture) sysinfo(t *testing.T, s wire.SysinfoRequest) {
	t.Helper()
	require.NoError(t, f.svc.Sysinfo(context.Background(), f.serverID, s, clientIP))
}

type deviceRow struct {
	ID            uuid.UUID
	UUID          string
	State         string
	Hostname      string
	OS            string
	CPU           string
	Memory        string
	ClientVersion string
	Username      string
	Presets       []byte
	LastSeenAt    time.Time
	UpdatedAt     time.Time
}

func (f *fixture) device(t *testing.T, rustdeskID string) deviceRow {
	t.Helper()
	var d deviceRow
	require.NoError(t, f.pool.QueryRow(context.Background(), `
		SELECT id, uuid, state, hostname, os, cpu, memory, client_version, username, presets, last_seen_at, updated_at
		FROM devices WHERE server_id = $1 AND rustdesk_id = $2`, f.serverID, rustdeskID).Scan(
		&d.ID, &d.UUID, &d.State, &d.Hostname, &d.OS, &d.CPU, &d.Memory, &d.ClientVersion,
		&d.Username, &d.Presets, &d.LastSeenAt, &d.UpdatedAt))
	return d
}

func (f *fixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, f.pool.QueryRow(context.Background(), query, args...).Scan(&n))
	return n
}

func (f *fixture) setState(t *testing.T, rustdeskID, state string) {
	t.Helper()
	_, err := f.pool.Exec(context.Background(),
		`UPDATE devices SET state = $3 WHERE server_id = $1 AND rustdesk_id = $2`, f.serverID, rustdeskID, state)
	require.NoError(t, err)
}

func (f *fixture) audits(t *testing.T, action string) []audit.Entry {
	t.Helper()
	got, _, err := audit.List(context.Background(), db.New(f.pool), audit.Filter{Action: action, Limit: 200})
	require.NoError(t, err)
	return got
}

func TestUnknownDeviceEnrollsPending(t *testing.T) {
	f := newFixture(t, 500)

	resp := f.heartbeat(t, "123456789", uuidA)
	require.Equal(t, wire.HeartbeatResponse{Sysinfo: true}, resp)

	require.Equal(t, 1, f.count(t, `SELECT count(*) FROM devices`))
	d := f.device(t, "123456789")
	require.Equal(t, devices.StatePending, d.State)
	require.Equal(t, uuidA, d.UUID)
	require.Nil(t, d.Presets)

	got := f.audits(t, devices.ActionEnrolled)
	require.Len(t, got, 1)
	require.Nil(t, got[0].ActorUserID)
	require.Equal(t, clientIP, got[0].ActorIP)
	require.Equal(t, "device", got[0].TargetType)
	require.Equal(t, d.ID.String(), got[0].TargetID)
	require.Equal(t, map[string]any{"rustdesk_id": "123456789"}, got[0].Details)

	// Pending devices are tracked so the approver can see them online.
	require.Equal(t, []beat{{"123456789", nil}}, f.beats.got())

	// Until sysinfo arrives, every heartbeat asks for it.
	require.Equal(t, wire.HeartbeatResponse{Sysinfo: true}, f.heartbeat(t, "123456789", uuidA))
	require.Len(t, f.audits(t, devices.ActionEnrolled), 1)
}

func TestConcurrentFirstHeartbeatsRespectPendingCap(t *testing.T) {
	f := newFixture(t, 3)
	const devices = 20
	start := make(chan struct{})
	errs := make(chan error, devices)
	var wg sync.WaitGroup
	for i := range devices {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := f.svc.Heartbeat(context.Background(), f.serverID,
				wire.HeartbeatRequest{ID: fmt.Sprintf("new-%d", i), UUID: uuidA}, clientIP)
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	require.Equal(t, 3, f.count(t, `SELECT count(*) FROM devices WHERE server_id = $1 AND state = 'pending'`, f.serverID))
}

func TestSysinfoFirstAlsoEnrolls(t *testing.T) {
	f := newFixture(t, 500)

	f.sysinfo(t, wire.SysinfoRequest{ID: "111", UUID: uuidA, Hostname: "laptop", OS: "Linux"})

	d := f.device(t, "111")
	require.Equal(t, devices.StatePending, d.State)
	require.Equal(t, uuidA, d.UUID)
	require.Equal(t, "laptop", d.Hostname)
	require.Equal(t, "Linux", d.OS)
	require.JSONEq(t, `{}`, string(d.Presets), "no presets is stored as {}, never NULL")
	require.Len(t, f.audits(t, devices.ActionEnrolled), 1)
	require.Empty(t, f.beats.got(), "sysinfo is not a heartbeat")

	require.Equal(t, wire.HeartbeatResponse{}, f.heartbeat(t, "111", uuidA))
}

func TestKnownDeviceStoresSysinfo(t *testing.T) {
	f := newFixture(t, 500)
	require.Equal(t, wire.HeartbeatResponse{Sysinfo: true}, f.heartbeat(t, "222", uuidA))

	f.sysinfo(t, wire.SysinfoRequest{
		ID: "222", UUID: uuidA, Version: "1.4.2", Hostname: "desk", OS: "Windows 11",
		CPU: "x86", Memory: "16GB", Username: "bob",
		Presets: map[string]string{"preset-device-group-name": "office"},
	})
	require.Equal(t, wire.HeartbeatResponse{}, f.heartbeat(t, "222", uuidA))

	d := f.device(t, "222")
	require.Equal(t, devices.StatePending, d.State)
	require.Equal(t, "desk", d.Hostname)
	require.Equal(t, "Windows 11", d.OS)
	require.Equal(t, "x86", d.CPU)
	require.Equal(t, "16GB", d.Memory)
	require.Equal(t, "1.4.2", d.ClientVersion)
	require.Equal(t, "bob", d.Username)
	require.JSONEq(t, `{"preset-device-group-name":"office"}`, string(d.Presets))

	// A later sysinfo replaces the stored values.
	f.sysinfo(t, wire.SysinfoRequest{ID: "222", UUID: uuidA, Version: "1.4.3", Hostname: "desk2"})
	d = f.device(t, "222")
	require.Equal(t, "desk2", d.Hostname)
	require.Equal(t, "1.4.3", d.ClientVersion)
	require.JSONEq(t, `{}`, string(d.Presets))
	require.Len(t, f.audits(t, devices.ActionEnrolled), 1)
}

func TestUUIDMismatchChangesNothing(t *testing.T) {
	f := newFixture(t, 500)
	f.sysinfo(t, wire.SysinfoRequest{ID: "333", UUID: uuidA, Hostname: "good"})
	before := f.device(t, "333")

	require.Equal(t, wire.HeartbeatResponse{}, f.heartbeat(t, "333", uuidB))
	f.sysinfo(t, wire.SysinfoRequest{ID: "333", UUID: uuidB, Hostname: "evil"})
	for i := 0; i < 3; i++ {
		require.Equal(t, wire.HeartbeatResponse{}, f.heartbeat(t, "333", uuidB))
	}

	require.Equal(t, before, f.device(t, "333"), "device row must be unchanged")
	require.Empty(t, f.beats.got(), "a mismatched heartbeat is not tracked")

	var details []byte
	require.NoError(t, f.pool.QueryRow(context.Background(), `
		SELECT details FROM device_alerts
		WHERE device_id = $1 AND kind = 'uuid_mismatch' AND resolved_at IS NULL`, before.ID).Scan(&details))
	require.JSONEq(t, fmt.Sprintf(`{"seen_uuid":%q,"ip":%q}`, uuidB, clientIP), string(details))
	require.Equal(t, 1, f.count(t, `SELECT count(*) FROM device_alerts`))

	got := f.audits(t, devices.ActionUUIDMismatch)
	require.Len(t, got, 1)
	require.Nil(t, got[0].ActorUserID)
	require.Equal(t, clientIP, got[0].ActorIP)
	require.Equal(t, "device", got[0].TargetType)
	require.Equal(t, before.ID.String(), got[0].TargetID)
	require.Equal(t, uuidB, got[0].Details["seen_uuid"])

	// Once the alert is resolved, the next mismatch opens and audits a new one.
	_, err := f.pool.Exec(context.Background(), `UPDATE device_alerts SET resolved_at = now()`)
	require.NoError(t, err)
	require.Equal(t, wire.HeartbeatResponse{}, f.heartbeat(t, "333", uuidB))
	require.Equal(t, 2, f.count(t, `SELECT count(*) FROM device_alerts`))
	require.Len(t, f.audits(t, devices.ActionUUIDMismatch), 2)
}

func TestRejectedAndArchivedIgnored(t *testing.T) {
	for _, state := range []string{devices.StateRejected, devices.StateArchived} {
		t.Run(state, func(t *testing.T) {
			f := newFixture(t, 500)
			// Enrolled by heartbeat, so no sysinfo is stored yet: a pending
			// device would be asked for it.
			f.heartbeat(t, "444", uuidA)
			f.setState(t, "444", state)
			f.beats = &fakeBeater{}
			f.svc.Beats = f.beats
			before := f.device(t, "444")
			audits := f.count(t, `SELECT count(*) FROM audit_events`)

			require.Equal(t, wire.HeartbeatResponse{}, f.heartbeat(t, "444", uuidA, 7))
			require.Equal(t, wire.HeartbeatResponse{}, f.heartbeat(t, "444", uuidB))
			f.sysinfo(t, wire.SysinfoRequest{ID: "444", UUID: uuidA, Hostname: "changed"})
			f.sysinfo(t, wire.SysinfoRequest{ID: "444", UUID: uuidB, Hostname: "evil"})

			require.Empty(t, f.beats.got())
			require.Equal(t, before, f.device(t, "444"))
			require.Equal(t, 0, f.count(t, `SELECT count(*) FROM device_alerts`))
			require.Equal(t, audits, f.count(t, `SELECT count(*) FROM audit_events`))
		})
	}
}

func TestPendingCap(t *testing.T) {
	f := newFixture(t, 2)

	require.Equal(t, wire.HeartbeatResponse{Sysinfo: true}, f.heartbeat(t, "a", uuidA))
	require.Equal(t, wire.HeartbeatResponse{Sysinfo: true}, f.heartbeat(t, "b", uuidA))
	require.Equal(t, wire.HeartbeatResponse{}, f.heartbeat(t, "c", uuidA))
	require.Equal(t, 2, f.count(t, `SELECT count(*) FROM devices`))

	got := f.audits(t, devices.ActionEnrollDropped)
	require.Len(t, got, 1)
	require.Nil(t, got[0].ActorUserID)
	require.Equal(t, clientIP, got[0].ActorIP)
	require.Equal(t, "server", got[0].TargetType)
	require.Equal(t, f.serverID.String(), got[0].TargetID)
	require.Equal(t, map[string]any{"rustdesk_id": "c"}, got[0].Details)

	// Within 10 minutes further drops (heartbeat or sysinfo) are not audited.
	f.now = t0.Add(10*time.Minute - time.Second)
	require.Equal(t, wire.HeartbeatResponse{}, f.heartbeat(t, "d", uuidA))
	f.sysinfo(t, wire.SysinfoRequest{ID: "e", UUID: uuidA, Hostname: "x"})
	require.Equal(t, 2, f.count(t, `SELECT count(*) FROM devices`))
	require.Len(t, f.audits(t, devices.ActionEnrollDropped), 1)
	require.Len(t, f.beats.got(), 2, "dropped devices are not tracked")

	f.now = t0.Add(10 * time.Minute)
	f.heartbeat(t, "f", uuidA)
	require.Len(t, f.audits(t, devices.ActionEnrollDropped), 2)

	// Known devices are unaffected by the cap, and approving one frees a slot.
	require.Equal(t, wire.HeartbeatResponse{Sysinfo: true}, f.heartbeat(t, "a", uuidA))
	f.setState(t, "a", devices.StateApproved)
	require.Equal(t, wire.HeartbeatResponse{Sysinfo: true}, f.heartbeat(t, "g", uuidA))
	require.Equal(t, 3, f.count(t, `SELECT count(*) FROM devices`))
}

func TestConcurrentEnrollmentCreatesOneDevice(t *testing.T) {
	f := newFixture(t, 500)
	ctx := context.Background()

	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var err error
			if i%2 == 0 {
				_, err = f.svc.Heartbeat(ctx, f.serverID, wire.HeartbeatRequest{ID: "555", UUID: uuidA}, clientIP)
			} else {
				err = f.svc.Sysinfo(ctx, f.serverID, wire.SysinfoRequest{ID: "555", UUID: uuidA, Hostname: "h"}, clientIP)
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}

	require.Equal(t, 1, f.count(t, `SELECT count(*) FROM devices`))
	require.Len(t, f.audits(t, devices.ActionEnrolled), 1)
	require.Equal(t, "h", f.device(t, "555").Hostname)
	require.Len(t, f.beats.got(), 10)
}

func TestApprovedHeartbeatBeats(t *testing.T) {
	f := newFixture(t, 500)
	f.sysinfo(t, wire.SysinfoRequest{ID: "666", UUID: uuidA, Hostname: "srv"})
	f.setState(t, "666", devices.StateApproved)

	require.Equal(t, wire.HeartbeatResponse{}, f.heartbeat(t, "666", uuidA, 3))
	require.Equal(t, []beat{{"666", []int32{3}}}, f.beats.got())

	// Approved devices still store sysinfo.
	f.sysinfo(t, wire.SysinfoRequest{ID: "666", UUID: uuidA, Hostname: "srv2",
		Presets: map[string]string{"preset-address-book-name": "ops"}})
	d := f.device(t, "666")
	require.Equal(t, "srv2", d.Hostname)
	var presets map[string]string
	require.NoError(t, json.Unmarshal(d.Presets, &presets))
	require.Equal(t, map[string]string{"preset-address-book-name": "ops"}, presets)
}
