package grouprules

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
)

type sortEnv struct {
	*Service
	a      devices.Actor
	server uuid.UUID
}

func newSortEnv(t *testing.T) *sortEnv {
	t.Helper()
	p := store.NewTestDB(t)
	e := &sortEnv{Service: &Service{Pool: p}, a: devices.Actor{IP: netip.MustParseAddr("203.0.113.5")}}
	ctx := context.Background()
	require.NoError(t, p.QueryRow(ctx, `INSERT INTO users(username,role,password_hash) VALUES('jane','owner','unused') RETURNING id`).Scan(&e.a.UserID))
	require.NoError(t, p.QueryRow(ctx, `INSERT INTO servers(name,id_host) VALUES('lab','rd.example.com') RETURNING id`).Scan(&e.server))
	return e
}

func (e *sortEnv) group(t *testing.T, name, pattern string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, e.Pool.QueryRow(context.Background(), `INSERT INTO device_groups(name) VALUES($1) RETURNING id`, name).Scan(&id))
	if pattern != "" {
		_, err := e.Pool.Exec(context.Background(), `INSERT INTO group_rules(group_id,pattern) VALUES($1,$2)`, id, pattern)
		require.NoError(t, err)
	}
	return id
}

func (e *sortEnv) device(t *testing.T, host, state string, group *uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, e.Pool.QueryRow(context.Background(), `INSERT INTO devices(server_id,rustdesk_id,uuid,hostname,state,group_id) VALUES($1,$2,'u',$3,$4,$5) RETURNING id`, e.server, uuid.NewString(), host, state, group).Scan(&id))
	return id
}

func count(t *testing.T, p *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, p.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

func TestAutoSortComputation(t *testing.T) {
	for _, name := range []string{"ungrouped", "override", "no_match", "same_group", "conflict_current_match", "pending", "rejected", "archived"} {
		t.Run(name, func(t *testing.T) {
			e := newSortEnv(t)
			g := e.group(t, "Target", "pc-*")
			manual := e.group(t, "Manual", "")
			var initial *uuid.UUID
			state, host := "approved", "pc-1"
			switch name {
			case "override", "no_match":
				initial = &manual
			case "same_group", "conflict_current_match":
				initial = &g
			case "pending", "rejected", "archived":
				state = name
			}
			if name == "no_match" {
				host = "unmatched"
			}
			if name == "conflict_current_match" {
				e.group(t, "Other", "pc-?")
			}
			id := e.device(t, host, state, initial)
			ctx := context.Background()
			preview, err := e.AutoSortPreview(ctx)
			require.NoError(t, err)
			require.Equal(t, 0, count(t, e.Pool, `SELECT count(*) FROM audit_events`))
			require.Equal(t, 0, count(t, e.Pool, `SELECT count(*) FROM device_alerts`))
			result, err := e.AutoSort(ctx, e.a)
			require.NoError(t, err)
			require.Equal(t, preview, result)
			want := initial
			switch name {
			case "ungrouped", "override":
				require.Len(t, result.Moves, 1)
				require.Equal(t, id, result.Moves[0].Device.ID)
				require.Equal(t, g, result.Moves[0].To.ID)
				if initial == nil {
					require.Nil(t, result.Moves[0].From)
				} else {
					require.Equal(t, *initial, result.Moves[0].From.ID)
				}
				want = &g
			case "conflict_current_match":
				require.Len(t, result.Conflicts, 1)
				require.Len(t, result.Conflicts[0].Groups, 2)
				require.Equal(t, 1, count(t, e.Pool, `SELECT count(*) FROM device_alerts WHERE resolved_at IS NULL`))
			case "no_match", "same_group":
				require.Equal(t, 1, result.Unchanged)
			default:
				require.Empty(t, result.Moves)
				require.Empty(t, result.Conflicts)
				require.Zero(t, result.Unchanged)
			}
			var actual *uuid.UUID
			require.NoError(t, e.Pool.QueryRow(ctx, `SELECT group_id FROM devices WHERE id=$1`, id).Scan(&actual))
			require.Equal(t, want, actual)
		})
	}
}

func TestAutoSortIdempotenceStaleConflictsAndAudit(t *testing.T) {
	e := newSortEnv(t)
	a := e.group(t, "A", "pc-*")
	b := e.group(t, "B", "pc-conflict")
	manual := e.group(t, "Manual", "")
	move := e.device(t, "pc-move", "approved", &manual)
	conflict := e.device(t, "pc-conflict", "approved", &a)
	e.device(t, "none", "approved", nil)
	ctx := context.Background()
	first, err := e.AutoSort(ctx, e.a)
	require.NoError(t, err)
	require.Len(t, first.Moves, 1)
	require.Len(t, first.Conflicts, 1)
	require.Equal(t, 1, first.Unchanged)
	var raw []byte
	require.NoError(t, e.Pool.QueryRow(ctx, `SELECT details FROM audit_events WHERE action='device.updated' AND target_id=$1`, move.String()).Scan(&raw))
	require.JSONEq(t, fmt.Sprintf(`{"before":{"group_id":%q},"after":{"group_id":%q},"reason":"auto_sort"}`, manual, a), string(raw))
	require.NoError(t, e.Pool.QueryRow(ctx, `SELECT details FROM audit_events WHERE action='devices.auto_sorted' AND target_type='devices' AND target_id=''`).Scan(&raw))
	require.JSONEq(t, `{"moved":1,"conflicts":1,"resolved":0,"unchanged":1}`, string(raw))
	var alert uuid.UUID
	var raised time.Time
	var version string
	require.NoError(t, e.Pool.QueryRow(ctx, `SELECT id,created_at,xmin::text FROM device_alerts WHERE device_id=$1`, conflict).Scan(&alert, &raised, &version))
	second, err := e.AutoSort(ctx, e.a)
	require.NoError(t, err)
	require.Empty(t, second.Moves)
	require.Equal(t, 2, second.Unchanged)
	require.Equal(t, 1, count(t, e.Pool, `SELECT count(*) FROM device_alerts WHERE id=$1 AND created_at=$2`, alert, raised))
	require.Equal(t, 1, count(t, e.Pool, `SELECT count(*) FROM device_alerts WHERE device_id=$1`, conflict))
	require.Equal(t, 1, count(t, e.Pool, `SELECT count(*) FROM device_alerts WHERE id=$1 AND xmin::text=$2 AND resolved_at IS NULL`, alert, version))
	require.Equal(t, 1, count(t, e.Pool, `SELECT count(*) FROM audit_events WHERE action='device.updated'`))
	c := e.group(t, "C", "pc-conflict")
	refreshed, err := e.AutoSort(ctx, e.a)
	require.NoError(t, err)
	require.Len(t, refreshed.Conflicts, 1)
	require.Len(t, refreshed.Conflicts[0].Groups, 3)
	require.Equal(t, 1, count(t, e.Pool, `SELECT count(*) FROM device_alerts WHERE id=$1 AND created_at=$2 AND jsonb_array_length(details->'group_ids')=3`, alert, raised))
	_, err = e.Pool.Exec(ctx, `DELETE FROM group_rules WHERE group_id=$1 OR group_id=$2`, b, c)
	require.NoError(t, err)
	third, err := e.AutoSort(ctx, e.a)
	require.NoError(t, err)
	require.Empty(t, third.Conflicts)
	require.Equal(t, 3, third.Unchanged)
	require.Equal(t, 1, count(t, e.Pool, `SELECT count(*) FROM device_alerts WHERE id=$1 AND resolved_at IS NOT NULL AND resolved_by=$2`, alert, e.a.UserID))
	require.Equal(t, 1, count(t, e.Pool, `SELECT count(*) FROM audit_events WHERE action='devices.auto_sorted' AND details->>'resolved'='1'`))
}

func TestAutoSortOrdering(t *testing.T) {
	e := newSortEnv(t)
	e.group(t, "A", "*")
	e.group(t, "B", "conflict-*")
	for _, host := range []string{"z", "a", "a", "conflict-z", "conflict-a", "conflict-a"} {
		e.device(t, host, "approved", nil)
	}
	r, err := e.AutoSortPreview(context.Background())
	require.NoError(t, err)
	require.Len(t, r.Moves, 3)
	require.Len(t, r.Conflicts, 3)
	for _, refs := range [][]RuleDeviceRef{{r.Moves[0].Device, r.Moves[1].Device, r.Moves[2].Device}, {r.Conflicts[0].Device, r.Conflicts[1].Device, r.Conflicts[2].Device}} {
		require.Less(t, refs[0].ID.String(), refs[1].ID.String())
		require.Less(t, refs[1].Hostname, refs[2].Hostname)
	}
}

func TestAutoSortLargeFleet(t *testing.T) {
	e := newSortEnv(t)
	for i := 0; i < 49; i++ {
		e.group(t, fmt.Sprint("Group", i), fmt.Sprintf("pc-%02d*", i))
	}
	e.group(t, "Conflicts", "pc-0*")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := e.Pool.Exec(ctx, `INSERT INTO devices(server_id,rustdesk_id,uuid,hostname,state) SELECT $1,n::text,'u','pc-'||lpad(n::text,4,'0'),'approved' FROM generate_series(0,4999) n`, e.server)
	require.NoError(t, err)
	listener, err := e.Pool.Acquire(ctx)
	require.NoError(t, err)
	defer listener.Release()
	_, err = listener.Exec(ctx, `LISTEN ferricade_events`)
	require.NoError(t, err)
	start := time.Now()
	r, err := e.AutoSort(ctx, e.a)
	elapsed := time.Since(start)
	require.NoError(t, err)
	require.Len(t, r.Moves, 3900)
	require.Len(t, r.Conflicts, 1000)
	require.Equal(t, 100, r.Unchanged)
	_, err = e.Pool.Exec(ctx, `SELECT pg_notify('ferricade_events','autosort-barrier')`)
	require.NoError(t, err)
	notifications := 0
	for {
		n, err := listener.Conn().WaitForNotification(ctx)
		require.NoError(t, err)
		if n.Payload == "autosort-barrier" {
			break
		}
		notifications++
	}
	t.Logf("AutoSortLargeFleet: %s, %d live-event notifications", elapsed, notifications)
	require.Less(t, elapsed, 15*time.Second)
	require.Equal(t, 4901, notifications, "3900 move audits + 1000 conflict alerts + the summary audit")
}

// A trigger holds the run on its first move so both competing requests are
// observed waiting on database locks, rather than relying on scheduler timing.
func TestAutoSortConcurrentRunsSerialize(t *testing.T) {
	e := newSortEnv(t)
	g := e.group(t, "Target", "pc-*")
	approved := e.device(t, "pc-approved", "approved", nil)
	pending := e.device(t, "pc-pending", "pending", nil)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_, err := e.Pool.Exec(ctx, `CREATE FUNCTION hold_sort_move() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(145,1); RETURN NEW; END $$; CREATE TRIGGER hold_sort_move BEFORE UPDATE OF group_id ON devices FOR EACH ROW EXECUTE FUNCTION hold_sort_move()`)
	require.NoError(t, err)
	barrier, err := e.Pool.Begin(ctx)
	require.NoError(t, err)
	defer barrier.Rollback(context.Background())
	_, err = barrier.Exec(ctx, `SELECT pg_advisory_xact_lock(145,1)`)
	require.NoError(t, err)
	type outcome struct {
		run    int
		result AutoSortResult
		err    error
	}
	done := make(chan outcome, 2)
	go func() { r, err := e.AutoSort(ctx, e.a); done <- outcome{0, r, err} }()
	waitLocks := func(n int) {
		require.Eventually(t, func() bool {
			return count(t, e.Pool, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`) >= n
		}, 4500*time.Millisecond, 10*time.Millisecond)
	}
	waitLocks(1)
	go func() { r, err := e.AutoSort(ctx, e.a); done <- outcome{1, r, err} }()
	waitLocks(2)
	approval := make(chan error, 1)
	ds := &devices.Service{Pool: e.Pool, GroupPlacement: e.Placement}
	go func() { approval <- ds.Transition(ctx, e.a, pending, devices.StateApproved, devices.StatePending) }()
	waitLocks(3)
	require.NoError(t, barrier.Commit(ctx))
	results := make([]AutoSortResult, 2)
	for range 2 {
		select {
		case o := <-done:
			require.NoError(t, o.err)
			results[o.run] = o.result
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	select {
	case err := <-approval:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	require.Len(t, results[0].Moves, 1)
	require.Empty(t, results[1].Moves)
	require.Equal(t, 1, count(t, e.Pool, `SELECT count(*) FROM audit_events WHERE action='device.updated' AND target_id=$1`, approved.String()))
	require.Equal(t, 2, count(t, e.Pool, `SELECT count(*) FROM devices WHERE state='approved' AND group_id=$1`, g))
	require.Equal(t, 2, count(t, e.Pool, `SELECT count(*) FROM audit_events WHERE action='devices.auto_sorted'`))
}

func TestAutoSortRollsBackOnAuditFailure(t *testing.T) {
	e := newSortEnv(t)
	e.group(t, "Target", "pc-*")
	e.device(t, "pc-1", "approved", nil)
	a := e.a
	a.IP = netip.Addr{}
	_, err := e.AutoSort(context.Background(), a)
	require.Error(t, err)
	require.Zero(t, count(t, e.Pool, `SELECT count(*) FROM devices WHERE group_id IS NOT NULL`))
	require.Zero(t, count(t, e.Pool, `SELECT count(*) FROM audit_events`))
}

func TestMatchHostnameByteLimit(t *testing.T) {
	for _, name := range []string{strings.Repeat("a", 255), strings.Repeat("é", 127) + "a"} {
		require.True(t, Match("*", name))
	}
	for _, name := range []string{strings.Repeat("a", 256), strings.Repeat("é", 128)} {
		require.False(t, Match("*", name))
	}
}

func TestRulePreviewCapAndNoGroupLock(t *testing.T) {
	e := newSortEnv(t)
	g := e.group(t, "Proposed", "")
	e.group(t, "Other", "pc-*")
	ctx := context.Background()
	_, err := e.Pool.Exec(ctx, `INSERT INTO devices(server_id,rustdesk_id,uuid,hostname,state) SELECT $1,n::text,'u','pc-'||n,'approved' FROM generate_series(1,205) n`, e.server)
	require.NoError(t, err)
	r, err := e.Preview(ctx, g, "pc-*")
	require.NoError(t, err)
	require.Len(t, r.Conflicts, 200)
	raw, err := json.Marshal(r)
	require.NoError(t, err)
	require.Contains(t, string(raw), `"conflict_count":205`)
	tx, err := e.Pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `SELECT id FROM device_groups WHERE id=$1 FOR UPDATE`, g)
	require.NoError(t, err)
	bounded, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	_, err = e.Preview(bounded, g, "pc-*")
	require.NoError(t, err, "a read-only preview must not wait on the group row lock")
}

func TestRulePreviewDoesNotLockGroup(t *testing.T) {
	e := newSortEnv(t)
	g := e.group(t, "Target", "*")
	ctx := context.Background()
	tx, err := e.Pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `SELECT id FROM device_groups WHERE id=$1 FOR UPDATE`, g)
	require.NoError(t, err)
	bounded, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	_, err = e.Preview(bounded, g, "*")
	require.NoError(t, err)
}

type queryTrace struct {
	mu  sync.Mutex
	sql []string
}

func (tr *queryTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	tr.sql = append(tr.sql, data.SQL)
	return ctx
}
func (*queryTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestAutoSortReadsRulesAndGroupsTogether(t *testing.T) {
	e := newSortEnv(t)
	e.group(t, "Target", "pc-*")
	e.device(t, "pc-1", "approved", nil)
	tr := &queryTrace{}
	cfg := e.Pool.Config()
	cfg.ConnConfig.Tracer = tr
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	require.NoError(t, err)
	defer pool.Close()
	svc := &Service{Pool: pool}
	for _, run := range []bool{false, true} {
		tr.sql = nil
		if run {
			_, err = svc.AutoSort(context.Background(), e.a)
		} else {
			_, err = svc.AutoSortPreview(context.Background())
		}
		require.NoError(t, err)
		joined := 0
		for _, sql := range tr.sql {
			if strings.Contains(sql, "group_rules") && strings.Contains(sql, "JOIN device_groups") {
				joined++
			}
		}
		require.Equal(t, 1, joined, "rules and their surviving group refs must share a snapshot")
	}
}

func TestDeviceListBatchesConflictGroups(t *testing.T) {
	e := newSortEnv(t)
	e.group(t, "A", "*")
	e.group(t, "B", "*")
	for _, host := range []string{"one", "two", "three"} {
		e.device(t, host, "approved", nil)
	}
	_, err := e.AutoSort(context.Background(), e.a)
	require.NoError(t, err)
	tr := &queryTrace{}
	cfg := e.Pool.Config()
	cfg.ConnConfig.Tracer = tr
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	require.NoError(t, err)
	defer pool.Close()
	svc := &devices.Service{Pool: pool}
	rows, _, err := svc.List(context.Background(), devices.Filter{}, nil)
	require.NoError(t, err)
	require.Len(t, rows, 3)
	for _, row := range rows {
		require.Len(t, row.OpenAlerts[0].Groups, 2)
	}
	queries := 0
	for _, sql := range tr.sql {
		if strings.Contains(sql, "-- name: ListConflictAlertGroups") {
			queries++
		}
	}
	require.Equal(t, 1, queries, "all listed conflict refs are loaded together")
}
