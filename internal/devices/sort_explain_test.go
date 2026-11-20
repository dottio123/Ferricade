package devices_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/store/db"
)

// explainDB measures the actual sqlc query rather than a hand-copied query
// that could drift from production. NewTestDB drops this seed on cleanup.
type explainDB struct {
	*pgxpool.Pool
	t     *testing.T
	label string
}

func (d explainDB) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	var raw []byte
	err := d.Pool.QueryRow(ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+sql, args...).Scan(&raw)
	if err != nil {
		return nil, err
	}
	var plan []struct {
		ExecutionTime float64 `json:"Execution Time"`
	}
	require.NoError(d.t, json.Unmarshal(raw, &plan))
	d.t.Logf("EXPLAIN %s: %.3f ms", d.label, plan[0].ExecutionTime)
	return d.Pool.Query(ctx, sql, args...)
}

func TestDeviceSortExplain(t *testing.T) {
	if os.Getenv("FERRICADE_SORT_EXPLAIN") != "1" {
		t.Skip("set FERRICADE_SORT_EXPLAIN=1 to measure 10,000 devices")
	}
	f := newFixture(t, 20000)
	ctx := context.Background()
	_, err := f.pool.Exec(ctx, `INSERT INTO device_groups (id,name)
		SELECT md5('group-' || n)::uuid, 'Group ' || n FROM generate_series(1,100) n`)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO devices (id,server_id,rustdesk_id,uuid,alias,hostname,os,state,group_id)
		SELECT md5('device-' || n)::uuid, $1, lpad(n::text,9,'0'), 'test',
		CASE WHEN n%3=0 THEN '' ELSE 'Alias ' || n%250 END, 'Host ' || n%500,
		CASE n%4 WHEN 0 THEN '' WHEN 1 THEN 'Windows' WHEN 2 THEN 'Linux' ELSE 'macOS' END,
		CASE n%4 WHEN 0 THEN 'pending' WHEN 1 THEN 'approved' WHEN 2 THEN 'rejected' ELSE 'archived' END,
		CASE WHEN n%5=0 THEN NULL ELSE md5('group-' || (n%100+1))::uuid END
		FROM generate_series(1,10000) n`, f.serverID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO device_alerts (device_id,kind,details)
		SELECT md5('device-' || n)::uuid, 'uuid_mismatch','{}' FROM generate_series(20,10000,20) n`)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `ANALYZE devices; ANALYZE device_groups; ANALYZE device_alerts`)
	require.NoError(t, err)
	var count int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM devices`).Scan(&count))
	require.Equal(t, 10000, count)
	var after uuid.UUID
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT id FROM devices WHERE rustdesk_id='000005000'`).Scan(&after))
	online := make([]uuid.UUID, 0, 1000)
	rows, err := f.pool.Query(ctx, `SELECT id FROM devices WHERE right(rustdesk_id,1)='1'`)
	require.NoError(t, err)
	for rows.Next() {
		var id uuid.UUID
		require.NoError(t, rows.Scan(&id))
		online = append(online, id)
	}
	rows.Close()
	require.NoError(t, rows.Err())
	for _, key := range []string{"rustdesk_id", "name", "status", "state", "os", "group"} {
		for _, desc := range []bool{false, true} {
			for _, cursor := range []*uuid.UUID{nil, &after} {
				label := key + " asc first"
				if desc {
					label = key + " desc first"
				}
				if cursor != nil {
					label += " after5000"
				}
				q := db.New(explainDB{Pool: f.pool, t: t, label: label})
				p := db.ListDevicesParams{SortKey: key, Descending: desc, AfterID: cursor, OnlineIds: online, RowLimit: 51}
				var err error
				if key == "group" {
					_, err = q.ListDevicesByGroup(ctx, db.ListDevicesByGroupParams(p))
				} else {
					_, err = q.ListDevices(ctx, p)
				}
				require.NoError(t, err)
			}
		}
	}
}
