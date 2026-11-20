package logexport

import (
	"context"
	"testing"

	"github.com/dottio123/ferricade/internal/store"
	"github.com/stretchr/testify/require"
)

func TestOutboxTriggers(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `INSERT INTO audit_events (actor_ip, action) VALUES ('203.0.113.5', 'auth.login')`)
	require.NoError(t, err)
	var source, phase string
	require.NoError(t, pool.QueryRow(ctx, `SELECT source, COALESCE(phase, '') FROM log_export_outbox ORDER BY id LIMIT 1`).Scan(&source, &phase))
	require.Equal(t, "audit", source)
	require.Empty(t, phase)
	var deviceID string
	require.NoError(t, pool.QueryRow(ctx, `WITH s AS (INSERT INTO servers (name,id_host) VALUES ('s','h') RETURNING id)
		INSERT INTO devices (server_id,rustdesk_id,uuid) SELECT id,'123456789','u' FROM s RETURNING id::text`).Scan(&deviceID))
	var sessionID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO remote_sessions (device_id,conn_id,started_at,conn_seen_at)
		VALUES ($1,1,now(),now()) RETURNING id::text`, deviceID).Scan(&sessionID))
	var phases []string
	require.NoError(t, pool.QueryRow(ctx, `SELECT array_agg(phase ORDER BY id) FROM log_export_outbox WHERE ref_id=$1`, sessionID).Scan(&phases))
	require.Equal(t, []string{"start"}, phases)
	_, err = pool.Exec(ctx, `UPDATE remote_sessions SET ended_at=now(),end_reason='closed' WHERE id=$1`, sessionID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE remote_sessions SET peer_name='late' WHERE id=$1`, sessionID)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT array_agg(phase ORDER BY id) FROM log_export_outbox WHERE ref_id=$1`, sessionID).Scan(&phases))
	require.Equal(t, []string{"start", "end"}, phases)
	_, err = pool.Exec(ctx, `INSERT INTO remote_sessions (device_id,conn_id,started_at,conn_seen_at,ended_at)
		VALUES ($1,2,now(),now(),now())`, deviceID)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT array_agg(phase ORDER BY id) FROM log_export_outbox WHERE source='session' AND ref_id<>$1`, sessionID).Scan(&phases))
	require.Equal(t, []string{"start", "end"}, phases)
}
