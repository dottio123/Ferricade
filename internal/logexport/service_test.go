package logexport

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestSyslogOutageThenRecovery(t *testing.T) {
	s, actor := testService(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	settings, err := s.Settings(context.Background())
	require.NoError(t, err)
	settings.Syslog = SyslogSettings{Enabled: true, Host: "127.0.0.1", Port: int32(port), Facility: "local0", Format: "json"}
	_, err = s.Update(context.Background(), actor, settings)
	require.NoError(t, err)
	t.Cleanup(s.closeSyslog)
	_, err = s.Pool.Exec(context.Background(), `DELETE FROM log_export_outbox`)
	require.NoError(t, err)
	clock := time.Now()
	s.Now = func() time.Time { return clock }
	got := make(chan string, 25)
	serve := func(ln net.Listener) chan net.Conn {
		connected := make(chan net.Conn, 1)
		go func() {
			_ = ln.(*net.TCPListener).SetDeadline(time.Now().Add(5 * time.Second))
			c, e := ln.Accept()
			if e != nil {
				return
			}
			connected <- c
			defer c.Close()
			_ = c.SetDeadline(time.Now().Add(5 * time.Second))
			r := bufio.NewReader(c)
			for {
				lengthText, e := r.ReadString(' ')
				if e != nil {
					return
				}
				length, e := strconv.Atoi(strings.TrimSpace(lengthText))
				if e != nil {
					return
				}
				msg := make([]byte, length)
				if _, e = io.ReadFull(r, msg); e != nil {
					return
				}
				var rec Record
				body := string(msg)
				cut := strings.LastIndex(body, " - ")
				if cut < 0 || json.Unmarshal([]byte(body[cut+3:]), &rec) != nil {
					return
				}
				got <- rec.Event.ID
			}
		}()
		return connected
	}
	firstConn := serve(listener)
	addAudits(t, s, 5)
	require.NoError(t, s.tick(context.Background()))
	conn := awaitSyslog(t, firstConn)
	var expected []string
	rows, err := s.Pool.Query(context.Background(), `SELECT ref_id::text FROM log_export_outbox ORDER BY id`)
	require.NoError(t, err)
	for rows.Next() {
		var id string
		require.NoError(t, rows.Scan(&id))
		expected = append(expected, id)
	}
	rows.Close()
	for _, id := range expected {
		require.Equal(t, id, awaitSyslog(t, got))
	}
	require.NoError(t, conn.Close())
	require.NoError(t, listener.Close())
	addAudits(t, s, 20)
	require.NoError(t, s.tick(context.Background()))
	require.NotNil(t, s.statuses["syslog"].LastError)
	require.Equal(t, 20, lenPendingSyslog(t, s))
	rows, err = s.Pool.Query(context.Background(), `SELECT ref_id::text FROM log_export_outbox ORDER BY id OFFSET 5`)
	require.NoError(t, err)
	expected = nil
	for rows.Next() {
		var id string
		require.NoError(t, rows.Scan(&id))
		expected = append(expected, id)
	}
	rows.Close()
	clock = s.retry["syslog"].next
	listener, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	require.NoError(t, err)
	defer listener.Close()
	serve(listener)
	require.NoError(t, s.tick(context.Background()))
	for _, id := range expected {
		require.Equal(t, id, awaitSyslog(t, got))
	}
	require.Empty(t, got)
	require.Zero(t, lenPendingSyslog(t, s))
}

func lenPendingSyslog(t *testing.T, s *Service) int {
	t.Helper()
	var n int
	require.NoError(t, s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM log_export_outbox WHERE syslog_done_at IS NULL`).Scan(&n))
	return n
}

func TestSyslogReconnectAfterIdleClose(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer ln.Close()
	out := &SyslogOutput{Host: "127.0.0.1", Port: ln.Addr().(*net.TCPAddr).Port, Facility: "local0", Format: "json"}
	defer out.Close()
	got := make(chan string, 2)
	closed := make(chan struct{}, 2)
	go func() {
		for i := 0; i < 2; i++ {
			_ = ln.(*net.TCPListener).SetDeadline(time.Now().Add(5 * time.Second))
			c, e := ln.Accept()
			if e != nil {
				return
			}
			_ = c.SetDeadline(time.Now().Add(5 * time.Second))
			got <- readSyslog(t, bufio.NewReader(c))
			_ = c.Close()
			closed <- struct{}{}
		}
	}()
	require.NoError(t, out.Deliver(context.Background(), []Record{testRecord("one")}))
	require.Contains(t, awaitSyslog(t, got), `"id":"one"`)
	awaitSyslog(t, closed)
	// Let the peer's FIN reach the client before checking an idle connection.
	time.Sleep(50 * time.Millisecond)
	require.NoError(t, out.Deliver(context.Background(), []Record{testRecord("two")}))
	require.Contains(t, awaitSyslog(t, got), `"id":"two"`)
}

func TestSyslogTLSReconnectAfterIdleClose(t *testing.T) {
	cert, ca := testTLSCert(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer ln.Close()
	out := &SyslogOutput{Host: "collector.test", Port: ln.Addr().(*net.TCPAddr).Port, TLS: true, CAPEM: ca, Facility: "local0", Format: "json"}
	out.dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", ln.Addr().String())
	}
	defer out.Close()
	got := make(chan string, 2)
	closed := make(chan struct{}, 2)
	go func() {
		for i := 0; i < 2; i++ {
			_ = ln.(*net.TCPListener).SetDeadline(time.Now().Add(5 * time.Second))
			raw, e := ln.Accept()
			if e != nil {
				return
			}
			_ = raw.SetDeadline(time.Now().Add(5 * time.Second))
			c := tls.Server(raw, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
			if e = c.Handshake(); e != nil {
				_ = c.Close()
				return
			}
			got <- readSyslog(t, bufio.NewReader(c))
			_ = c.Close()
			closed <- struct{}{}
		}
	}()
	require.NoError(t, out.Deliver(context.Background(), []Record{testRecord("one")}))
	require.Contains(t, awaitSyslog(t, got), `"id":"one"`)
	awaitSyslog(t, closed)
	// Wait for close_notify and FIN before the next idle connection check.
	time.Sleep(50 * time.Millisecond)
	require.NoError(t, out.Deliver(context.Background(), []Record{testRecord("two")}))
	require.Contains(t, awaitSyslog(t, got), `"id":"two"`)
}

func awaitSyslog[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for syslog test channel")
		var zero T
		return zero
	}
}

type captureOutput struct {
	batches [][]Record
	err     error
}

func (*captureOutput) Name() string { return "file" }
func (o *captureOutput) Deliver(_ context.Context, recs []Record) error {
	if o.err != nil {
		return o.err
	}
	o.batches = append(o.batches, append([]Record(nil), recs...))
	return nil
}

func testService(t *testing.T) (*Service, devices.Actor) {
	t.Helper()
	pool := store.NewTestDB(t)
	var id uuid.UUID
	require.NoError(t, pool.QueryRow(context.Background(), `INSERT INTO users (username,role,password_hash) VALUES ('jane','owner','x') RETURNING id`).Scan(&id))
	s := &Service{Pool: pool, Dir: t.TempDir(), Host: "ferricade.example.com", Now: time.Now}
	return s, devices.Actor{UserID: id, IP: netip.MustParseAddr("203.0.113.5")}
}
func enableFile(t *testing.T, s *Service, a devices.Actor) {
	t.Helper()
	settings, err := s.Settings(context.Background())
	require.NoError(t, err)
	settings.File.Enabled = true
	_, err = s.Update(context.Background(), a, settings)
	require.NoError(t, err)
}
func addAudits(t *testing.T, s *Service, n int) {
	t.Helper()
	_, err := s.Pool.Exec(context.Background(), `INSERT INTO audit_events (actor_ip,action)
		SELECT '203.0.113.5','auth.login' FROM generate_series(1,$1::int)`, n)
	require.NoError(t, err)
}

func TestBuildBatchMatchesIndividualRecords(t *testing.T) {
	s, a := testService(t)
	ctx := context.Background()
	var serverID, deviceID uuid.UUID
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO servers (name, id_host) VALUES ('batch-server','rd.example') RETURNING id`).Scan(&serverID))
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid, alias) VALUES ($1,'123456789','batch-uuid','Front Desk') RETURNING id`, serverID).Scan(&deviceID))
	started := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	require.NoError(t, s.Pool.QueryRow(ctx, `INSERT INTO remote_sessions (device_id,conn_id,peer_rustdesk_id,peer_name,started_at,conn_seen_at) VALUES ($1,7,'987654321','Laptop',$2,$2) RETURNING id`, deviceID, started).Scan(new(uuid.UUID)))
	_, err := s.Pool.Exec(ctx, `INSERT INTO audit_events (actor_user_id,actor_ip,action,target_type,target_id,details) VALUES ($1,'203.0.113.5','device.approved','device',$2,'{}')`, a.UserID, deviceID.String())
	require.NoError(t, err)
	rows, err := db.New(s.Pool).PendingFileLogExport(ctx)
	require.NoError(t, err)
	require.Len(t, rows, 2)

	want := make(map[int64][]byte, len(rows))
	for _, row := range rows {
		rec, err := Build(ctx, db.New(s.Pool), row, s.Host)
		require.NoError(t, err)
		want[row.ID], err = json.Marshal(rec)
		require.NoError(t, err)
	}
	before := s.Pool.Stat().AcquireCount()
	got, rowErrors, err := BuildBatch(ctx, db.New(s.Pool), rows, s.Host)
	require.NoError(t, err)
	require.Empty(t, rowErrors)
	require.EqualValues(t, 2, s.Pool.Stat().AcquireCount()-before)
	for id, rec := range got {
		actual, err := json.Marshal(rec)
		require.NoError(t, err)
		require.Equal(t, want[id], actual)
	}
}

func TestDeliverKeepsGoodRowsWhenOneReferenceIsMissing(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	addAudits(t, s, 1)
	_, err := s.Pool.Exec(ctx, `INSERT INTO log_export_outbox (source,ref_id) VALUES ('audit',$1)`, uuid.New())
	require.NoError(t, err)
	out := &captureOutput{}
	require.NoError(t, s.deliver(ctx, "file", out))
	require.Len(t, out.batches, 1)
	require.Len(t, out.batches[0], 1)
	var pending int
	require.NoError(t, s.Pool.QueryRow(ctx, `SELECT count(*) FROM log_export_outbox WHERE file_done_at IS NULL`).Scan(&pending))
	require.Zero(t, pending)
}

func TestEnableStartsAtNow(t *testing.T) {
	s, a := testService(t)
	addAudits(t, s, 3)
	enableFile(t, s, a)
	var pending int
	require.NoError(t, s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM log_export_outbox WHERE file_done_at IS NULL`).Scan(&pending))
	require.Equal(t, 1, pending, "only the settings audit is new")
	addAudits(t, s, 1)
	require.NoError(t, s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM log_export_outbox WHERE file_done_at IS NULL`).Scan(&pending))
	require.Equal(t, 2, pending)
}

func TestCleanupSevenDays(t *testing.T) {
	s, a := testService(t)
	enableFile(t, s, a)
	addAudits(t, s, 2)
	_, err := s.Pool.Exec(context.Background(), `UPDATE log_export_outbox SET created_at=now()-interval '8 days' WHERE id=(SELECT max(id) FROM log_export_outbox)`)
	require.NoError(t, err)
	require.NoError(t, s.cleanup(context.Background(), true, false))
	var count int
	require.NoError(t, s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM log_export_outbox`).Scan(&count))
	require.Equal(t, 2, count, "old pending is removed; current pending survives")
}

func TestMissingRefMarkedDone(t *testing.T) {
	s, a := testService(t)
	enableFile(t, s, a)
	var id int64
	require.NoError(t, s.Pool.QueryRow(context.Background(), `INSERT INTO log_export_outbox (source,ref_id) VALUES ('audit',$1) RETURNING id`, uuid.New()).Scan(&id))
	s.file = &captureOutput{}
	require.NoError(t, s.tick(context.Background()))
	var done bool
	require.NoError(t, s.Pool.QueryRow(context.Background(), `SELECT file_done_at IS NOT NULL FROM log_export_outbox WHERE id=$1`, id).Scan(&done))
	require.True(t, done)
}

func TestExporterDrainsBurstInBatches(t *testing.T) {
	s, a := testService(t)
	enableFile(t, s, a)
	_, err := s.Pool.Exec(context.Background(), `DELETE FROM log_export_outbox`)
	require.NoError(t, err)
	start := time.Now()
	addAudits(t, s, 10000)
	require.Less(t, time.Since(start), 30*time.Second, "writer only inserts outbox rows")
	out := &captureOutput{}
	s.file = out
	require.NoError(t, s.tick(context.Background()))
	require.Len(t, out.batches, 20)
	for _, b := range out.batches {
		require.Len(t, b, 500)
	}
	rows, err := s.Pool.Query(context.Background(), `SELECT ref_id::text FROM log_export_outbox ORDER BY id`)
	require.NoError(t, err)
	var expected []string
	for rows.Next() {
		var id string
		require.NoError(t, rows.Scan(&id))
		expected = append(expected, id)
	}
	rows.Close()
	var got []string
	for _, b := range out.batches {
		for _, r := range b {
			got = append(got, r.Event.ID)
		}
	}
	require.Equal(t, expected, got)
}

func TestBackoffCapsAtOneMinute(t *testing.T) {
	s, a := testService(t)
	enableFile(t, s, a)
	addAudits(t, s, 1)
	clock := time.Date(2026, 10, 21, 14, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return clock }
	out := &captureOutput{err: errors.New("collector down")}
	s.file = out
	for i, want := range []time.Duration{2, 4, 8, 16, 32, 60, 60, 60} {
		require.NoError(t, s.tick(context.Background()))
		delay := s.retry["file"].next.Sub(clock)
		require.Equal(t, want*time.Second, delay, "failure %d", i+1)
		clock = clock.Add(delay)
	}
}

func TestDeliveryErrorTruncatesAtRuneBoundary(t *testing.T) {
	s := &Service{Now: time.Now}
	s.failure("syslog", errors.New(strings.Repeat("x", 1023)+"é"))
	status := s.statuses["syslog"]
	require.NotNil(t, status.LastError)
	require.Equal(t, strings.Repeat("x", 1023), *status.LastError)
}

func syslogListener(t *testing.T, count int) (int32, <-chan string, func(), *net.TCPListener) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	got := make(chan string, count)
	go func() {
		_ = ln.(*net.TCPListener).SetDeadline(time.Now().Add(5 * time.Second))
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		r := bufio.NewReader(conn)
		for i := 0; i < count; i++ {
			got <- readSyslog(t, r)
		}
	}()
	return int32(ln.Addr().(*net.TCPAddr).Port), got, func() { _ = ln.Close() }, ln.(*net.TCPListener)
}

func TestUpdateExportsDisableAndRedirectToOldOutput(t *testing.T) {
	t.Run("syslog off", func(t *testing.T) {
		s, actor := testService(t)
		port, got, stop, _ := syslogListener(t, 1)
		defer stop()
		settings, err := s.Settings(context.Background())
		require.NoError(t, err)
		settings.Syslog = SyslogSettings{Enabled: true, Host: "127.0.0.1", Port: port, Facility: "local0", Format: "json"}
		_, err = s.Update(context.Background(), actor, settings)
		require.NoError(t, err)
		settings.Syslog.Enabled = false
		_, err = s.Update(context.Background(), actor, settings)
		require.NoError(t, err)
		require.Contains(t, awaitSyslog(t, got), `"syslog.enabled"`)
	})
	t.Run("syslog redirect", func(t *testing.T) {
		s, actor := testService(t)
		portA, old, stopA, _ := syslogListener(t, 1)
		defer stopA()
		portB, current, stopB, _ := syslogListener(t, 2)
		defer stopB()
		settings, err := s.Settings(context.Background())
		require.NoError(t, err)
		settings.Syslog = SyslogSettings{Enabled: true, Host: "127.0.0.1", Port: portA, Facility: "local0", Format: "json"}
		_, err = s.Update(context.Background(), actor, settings)
		require.NoError(t, err)
		settings.Syslog.Port = portB
		_, err = s.Update(context.Background(), actor, settings)
		require.NoError(t, err)
		require.Contains(t, awaitSyslog(t, old), `"syslog.port"`)
		require.NoError(t, s.tick(context.Background()))
		_ = awaitSyslog(t, current)
		require.Contains(t, awaitSyslog(t, current), `"syslog.port"`)
		s.closeSyslog()
	})
	t.Run("file off", func(t *testing.T) {
		s, actor := testService(t)
		settings, err := s.Settings(context.Background())
		require.NoError(t, err)
		settings.File.Enabled = true
		_, err = s.Update(context.Background(), actor, settings)
		require.NoError(t, err)
		settings.File.Enabled = false
		_, err = s.Update(context.Background(), actor, settings)
		require.NoError(t, err)
		data, err := os.ReadFile(filepath.Join(s.Dir, "events.jsonl"))
		require.NoError(t, err)
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		require.Contains(t, lines[len(lines)-1], `"file.enabled"`)
	})
}

type replacingOutput struct {
	*SyslogOutput
	afterFirst func()
	count      int
}

func (o *replacingOutput) Deliver(ctx context.Context, recs []Record) error {
	err := o.SyslogOutput.Deliver(ctx, recs)
	o.count++
	if o.count == 1 {
		o.afterFirst()
	}
	return err
}

func TestSyslogReplacementStopsMidTick(t *testing.T) {
	s, actor := testService(t)
	port, got, stop, ln := syslogListener(t, 500)
	defer stop()
	settings, err := s.Settings(context.Background())
	require.NoError(t, err)
	settings.Syslog = SyslogSettings{Enabled: true, Host: "127.0.0.1", Port: port, Facility: "local0", Format: "json"}
	_, err = s.Update(context.Background(), actor, settings)
	require.NoError(t, err)
	_, err = s.Pool.Exec(context.Background(), `DELETE FROM log_export_outbox`)
	require.NoError(t, err)
	addAudits(t, s, 501)
	out := s.syslogOutput(settings.Syslog)
	other, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer other.Close()
	wrapped := &replacingOutput{SyslogOutput: out, afterFirst: func() {
		settings.Syslog.Port = int32(other.Addr().(*net.TCPAddr).Port)
		_, err := s.Update(context.Background(), actor, settings)
		require.NoError(t, err)
	}}
	require.NoError(t, s.deliver(context.Background(), "syslog", wrapped))
	require.Equal(t, 2, wrapped.count)
	for i := 0; i < 500; i++ {
		_ = awaitSyslog(t, got)
	}
	// The redirect audit uses the old collector; the backlog must not open another connection there.
	require.NoError(t, ln.SetDeadline(time.Now().Add(5*time.Second)))
	auditConn, err := ln.Accept()
	require.NoError(t, err)
	require.NoError(t, auditConn.SetDeadline(time.Now().Add(5*time.Second)))
	require.Contains(t, readSyslog(t, bufio.NewReader(auditConn)), `"syslog.port"`)
	require.NoError(t, auditConn.Close())
	require.NoError(t, ln.SetDeadline(time.Now().Add(100*time.Millisecond)))
	_, err = ln.Accept()
	var timeout net.Error
	require.ErrorAs(t, err, &timeout)
	require.True(t, timeout.Timeout())
	status, err := s.Status(context.Background())
	require.NoError(t, err)
	require.Nil(t, status["syslog"].LastError)
	require.Equal(t, int64(2), status["syslog"].Pending)
}

func TestFileOutputUnwritableKeepsBacklog(t *testing.T) {
	s, a := testService(t)
	enableFile(t, s, a)
	addAudits(t, s, 1)
	bad := filepath.Join(t.TempDir(), "regular-file")
	require.NoError(t, os.WriteFile(bad, []byte("x"), 0600))
	s.Dir = bad
	require.NoError(t, s.tick(context.Background()))
	status, err := s.Status(context.Background())
	require.NoError(t, err)
	require.NotNil(t, status["file"].LastError)
	require.Contains(t, *status["file"].LastError, bad)
	require.Greater(t, status["file"].Pending, int64(0))
	require.NoError(t, os.Remove(bad))
	require.NoError(t, os.Mkdir(bad, 0750))
	// A simulated clock advances past the retry without sleeping.
	next := s.retry["file"].next
	s.Now = func() time.Time { return next }
	require.NoError(t, s.tick(context.Background()))
	data, err := os.ReadFile(filepath.Join(bad, "events.jsonl"))
	require.NoError(t, err)
	require.Contains(t, string(data), `"action":"auth.login"`)
	status, err = s.Status(context.Background())
	require.NoError(t, err)
	require.Equal(t, int64(0), status["file"].Pending)
	t.Run("read-only directory", func(t *testing.T) {
		if os.Geteuid() == 0 || runtime.GOOS == "windows" {
			t.Skip("directory mode bits do not restrict this process; regular-file path above covers the backlog")
		}
		other, actor := testService(t)
		enableFile(t, other, actor)
		addAudits(t, other, 1)
		readOnly := t.TempDir()
		require.NoError(t, os.Chmod(readOnly, 0500))
		defer os.Chmod(readOnly, 0750)
		other.Dir = readOnly
		require.NoError(t, other.tick(context.Background()))
		state, err := other.Status(context.Background())
		require.NoError(t, err)
		require.NotNil(t, state["file"].LastError)
		require.Greater(t, state["file"].Pending, int64(0))
		require.NoError(t, os.Chmod(readOnly, 0750))
		next := other.retry["file"].next
		other.Now = func() time.Time { return next }
		require.NoError(t, other.tick(context.Background()))
		state, err = other.Status(context.Background())
		require.NoError(t, err)
		require.Zero(t, state["file"].Pending)
	})
}
