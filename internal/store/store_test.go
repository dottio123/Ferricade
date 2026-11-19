package store_test

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func TestMigrateIsIdempotent(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	require.NoError(t, store.Migrate(ctx, pool))
	require.NoError(t, store.Migrate(ctx, pool))
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, os.DirFS("migrations"))
	require.NoError(t, err)
	_, err = provider.DownTo(ctx, 7)
	require.NoError(t, err)
	var roleCheck string
	require.NoError(t, pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'users_role_check'`).Scan(&roleCheck))
	require.NotContains(t, roleCheck, "'user'")
	requireSQLState(t, pool, "23514", `INSERT INTO users (username, role, password_hash) VALUES ('before-up', 'user', 'x')`)
	require.NoError(t, store.Migrate(ctx, pool))
	require.NoError(t, pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'users_role_check'`).Scan(&roleCheck))
	require.Contains(t, roleCheck, "'user'")
	_, err = pool.Exec(ctx, `INSERT INTO users (username, role, password_hash) VALUES ('after-up', 'user', 'x')`)
	require.NoError(t, err)
}

func TestMigrationRenamesDatabaseFunctionBodies(t *testing.T) {
	pool := store.NewTestDB(t)
	var names []string
	rows, err := pool.Query(context.Background(), `SELECT proname FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'public' AND prosrc ILIKE '%' || 'rd' || 'admin' || '%'`)
	require.NoError(t, err)
	for rows.Next() {
		var name string
		require.NoError(t, rows.Scan(&name))
		names = append(names, name)
	}
	require.NoError(t, rows.Err())
	rows.Close()
	require.Empty(t, names)
}

func TestSettingsRoundTrip(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)

	require.NoError(t, q.PutSetting(ctx, db.PutSettingParams{Key: "setup_complete", Value: []byte(`true`)}))
	got, err := q.GetSetting(ctx, "setup_complete")
	require.NoError(t, err)
	require.JSONEq(t, `true`, string(got))

	require.NoError(t, q.PutSetting(ctx, db.PutSettingParams{Key: "setup_complete", Value: []byte(`false`)}))
	got, err = q.GetSetting(ctx, "setup_complete")
	require.NoError(t, err)
	require.JSONEq(t, `false`, string(got))
}

func TestAuditEventsAppendOnly(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()

	var id string
	err := pool.QueryRow(ctx, `INSERT INTO audit_events (actor_ip, action, target_type, target_id, details)
		VALUES ('192.0.2.1', 'test.event', 'device', 'x', '{}') RETURNING id::text`).Scan(&id)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `UPDATE audit_events SET action = 'tampered' WHERE id = $1`, id)
	require.ErrorContains(t, err, "append-only")

	_, err = pool.Exec(ctx, `DELETE FROM audit_events WHERE id = $1`, id)
	require.ErrorContains(t, err, "append-only")

	var action string
	require.NoError(t, pool.QueryRow(ctx, `SELECT action FROM audit_events WHERE id = $1`, id).Scan(&action))
	require.Equal(t, "test.event", action)
}

func TestTxRollsBackOnError(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()

	errX := errors.New("x")
	err := store.Tx(ctx, pool, func(q *db.Queries) error {
		if err := q.PutSetting(ctx, db.PutSettingParams{Key: "setup_complete", Value: []byte(`true`)}); err != nil {
			return err
		}
		return errX
	})
	require.ErrorIs(t, err, errX)

	_, err = db.New(pool).GetSetting(ctx, "setup_complete")
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestTxCommitsOnNil(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()

	err := store.Tx(ctx, pool, func(q *db.Queries) error {
		return q.PutSetting(ctx, db.PutSettingParams{Key: "enrollment_policy", Value: []byte(`"approval"`)})
	})
	require.NoError(t, err)

	got, err := db.New(pool).GetSetting(ctx, "enrollment_policy")
	require.NoError(t, err)
	require.JSONEq(t, `"approval"`, string(got))
}

func TestNewTestDBIsolated(t *testing.T) {
	ctx := context.Background()
	var a, b string
	require.NoError(t, store.NewTestDB(t).QueryRow(ctx, `SELECT current_database()`).Scan(&a))
	require.NoError(t, store.NewTestDB(t).QueryRow(ctx, `SELECT current_database()`).Scan(&b))
	require.NotEqual(t, a, b)
}

func TestSchemaHasEveryTable(t *testing.T) {
	pool := store.NewTestDB(t)
	rows, err := pool.Query(context.Background(),
		`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'goose_db_version'`)
	require.NoError(t, err)
	got, err := pgx.CollectRows(rows, pgx.RowTo[string])
	require.NoError(t, err)
	require.ElementsMatch(t, []string{
		"users", "sessions", "servers", "devices", "device_alerts",
		"device_groups", "tags", "device_tags", "audit_events", "settings",
		"remote_sessions", "seen_nonces", "fleet_snapshots", "user_preferences", "oidc_settings", "user_grants", "deployment_profile",
		"client_policies", "client_policy_settings", "access_windows", "log_export_settings", "log_export_outbox",
		"group_rules", "session_settings", "global_id_allow_list", "id_blocked_alarm_windows", "id_blocked_alarm_overflow",
	}, got)
}

func TestAuditSessionIndexes(t *testing.T) {
	pool := store.NewTestDB(t)
	for name, definition := range map[string]string{
		"audit_events_target_at_id_idx":         "(target_id, at DESC, id DESC)",
		"audit_events_actor_at_id_idx":          "(actor_user_id, at DESC, id DESC)",
		"remote_sessions_open_conn_seen_at_idx": "(conn_seen_at) WHERE (ended_at IS NULL)",
	} {
		var got string
		err := pool.QueryRow(context.Background(), `SELECT indexdef FROM pg_indexes
			WHERE schemaname = 'public' AND indexname = $1`, name).Scan(&got)
		require.NoError(t, err, "expected index %s", name)
		require.Contains(t, got, definition)
	}
}

func TestClientPolicyMigration(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	var defaults, settings int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM client_policies WHERE is_default`).Scan(&defaults))
	require.Equal(t, 1, defaults)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM client_policy_settings`).Scan(&settings))
	require.Equal(t, 1, settings)
	requireSQLState(t, pool, "23505", `INSERT INTO client_policies (name, settings, is_default) VALUES ('Other', '{}', true)`)
	var serverID, deviceID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO servers (name, id_host) VALUES ('s', 'h') RETURNING id::text`).Scan(&serverID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO devices (server_id, rustdesk_id, uuid) VALUES ($1, '1', 'u') RETURNING id::text`, serverID).Scan(&deviceID))
	_, err := pool.Exec(ctx, `INSERT INTO access_windows (device_id) VALUES ($1)`, deviceID)
	require.NoError(t, err)
	requireSQLState(t, pool, "23505", `INSERT INTO access_windows (device_id) VALUES ($1)`, deviceID)
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, os.DirFS("migrations"))
	require.NoError(t, err)
	_, err = provider.DownTo(ctx, 12)
	require.NoError(t, err)
	var exists bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT to_regclass('client_policies') IS NOT NULL`).Scan(&exists))
	require.False(t, exists)
	require.NoError(t, store.Migrate(ctx, pool))
}

// requireSQLState runs sql and checks it fails with the given SQLSTATE.
func requireSQLState(t *testing.T, pool interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, code, sql string, args ...any) {
	t.Helper()
	_, err := pool.Exec(context.Background(), sql, args...)
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr, sql)
	require.Equal(t, code, pgErr.Code, sql)
}

func TestSchemaConstraints(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	const checkViolation, uniqueViolation = "23514", "23505"

	requireSQLState(t, pool, checkViolation,
		`INSERT INTO users (username, role, password_hash) VALUES ('a', 'root', 'x')`)

	// Root groups (NULL parent) with the same name collide.
	_, err := pool.Exec(ctx, `INSERT INTO device_groups (name) VALUES ('Office')`)
	require.NoError(t, err)
	requireSQLState(t, pool, uniqueViolation, `INSERT INTO device_groups (name) VALUES ('Office')`)

	var serverID string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO servers (name, id_host) VALUES ('s', 'h') RETURNING id::text`).Scan(&serverID))
	requireSQLState(t, pool, checkViolation,
		`INSERT INTO devices (server_id, rustdesk_id, uuid, state) VALUES ($1, '1', 'u', 'bogus')`, serverID)

	var deviceID string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO devices (server_id, rustdesk_id, uuid) VALUES ($1, '1', 'u') RETURNING id::text`, serverID).Scan(&deviceID))
	requireSQLState(t, pool, uniqueViolation,
		`INSERT INTO devices (server_id, rustdesk_id, uuid) VALUES ($1, '1', 'u2')`, serverID)

	// Only one open alert per (device, kind); a resolved one does not count.
	_, err = pool.Exec(ctx, `INSERT INTO device_alerts (device_id, kind, resolved_at) VALUES ($1, 'uuid_mismatch', now())`, deviceID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO device_alerts (device_id, kind) VALUES ($1, 'uuid_mismatch')`, deviceID)
	require.NoError(t, err)
	requireSQLState(t, pool, uniqueViolation,
		`INSERT INTO device_alerts (device_id, kind) VALUES ($1, 'uuid_mismatch')`, deviceID)

	// Only one open remote session per (device, conn_id); an ended one does
	// not count.
	_, err = pool.Exec(ctx, `INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at, ended_at, end_reason)
		VALUES ($1, 3, now(), now(), now(), 'closed')`, deviceID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at) VALUES ($1, 3, now(), now())`, deviceID)
	require.NoError(t, err)
	requireSQLState(t, pool, uniqueViolation,
		`INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at) VALUES ($1, 3, now(), now())`, deviceID)
	requireSQLState(t, pool, checkViolation,
		`INSERT INTO remote_sessions (device_id, conn_id, started_at, conn_seen_at, ended_at, end_reason)
		 VALUES ($1, 4, now(), now(), now(), 'bogus')`, deviceID)
}

func TestInetRoundTripsAsNetipAddr(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	for _, ip := range []netip.Addr{netip.MustParseAddr("192.0.2.7"), netip.MustParseAddr("2001:db8::1")} {
		var got netip.Addr
		require.NoError(t, pool.QueryRow(ctx,
			`INSERT INTO audit_events (actor_ip, action) VALUES ($1, 'test') RETURNING actor_ip`, ip).Scan(&got))
		require.Equal(t, ip, got)
	}
}

func TestTimestampsScanAsUTC(t *testing.T) {
	pool := store.NewTestDB(t)
	var at time.Time
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT now()`).Scan(&at))
	require.Equal(t, time.UTC, at.Location())
}

func TestTagColorHoldsUnsignedARGB(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	const work int64 = 4280391411 // 0xFF2196F3, from the Phase 0 fixtures
	_, err := pool.Exec(ctx, `INSERT INTO tags (name, color) VALUES ('work', $1)`, work)
	require.NoError(t, err)

	var tag db.Tag
	require.NoError(t, pool.QueryRow(ctx, `SELECT id, name, color FROM tags WHERE name = 'work'`).
		Scan(&tag.ID, &tag.Name, &tag.Color))
	require.Equal(t, work, tag.Color)
}

func TestTxRollsBackOnPanic(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()

	func() {
		defer func() {
			require.Equal(t, "boom", recover(), "the panic propagates")
		}()
		_ = store.Tx(ctx, pool, func(q *db.Queries) error {
			require.NoError(t, q.PutSetting(ctx, db.PutSettingParams{Key: "panicked", Value: []byte(`true`)}))
			panic("boom")
		})
	}()

	require.Zero(t, pool.Stat().AcquiredConns(), "the connection went back to the pool")
	_, err := db.New(pool).GetSetting(ctx, "panicked")
	require.ErrorIs(t, err, pgx.ErrNoRows, "the write was rolled back")
}
