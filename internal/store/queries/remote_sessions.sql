-- name: InsertSeenNonce :execrows
-- Affects no row when the nonce was already seen.
INSERT INTO seen_nonces (nonce, seen_at) VALUES ($1, $2)
ON CONFLICT (nonce) DO NOTHING;

-- name: MergeNewIntoAuthedRemoteSession :execrows
-- Applies a late "new" record to the open session on conn_id that an auth
-- record opened (it has authed_at but no client_ip): the two records were
-- delivered out of order, so this is the same connection, not a reuse.
UPDATE remote_sessions SET
    client_ip     = sqlc.narg(client_ip)::inet,
    rd_session_id = COALESCE(rd_session_id, sqlc.narg(rd_session_id)::numeric),
    started_at    = LEAST(started_at, sqlc.arg(now)),
    conn_seen_at  = sqlc.arg(now)
WHERE device_id = sqlc.arg(device_id) AND conn_id = sqlc.arg(conn_id) AND ended_at IS NULL
  AND client_ip IS NULL AND authed_at IS NOT NULL;

-- name: EndOpenRemoteSessionStale :exec
-- Ends the device's open session on conn_id, if any, as stale: the client
-- reused the conn_id, so the old connection is gone.
UPDATE remote_sessions SET ended_at = conn_seen_at, end_reason = 'stale'
WHERE device_id = $1 AND conn_id = $2 AND ended_at IS NULL;

-- name: OpenRemoteSession :exec
-- Does nothing when a session on conn_id is already open (a concurrent
-- record opened it first).
INSERT INTO remote_sessions (device_id, conn_id, rd_session_id, client_ip, started_at, conn_seen_at)
VALUES (sqlc.arg(device_id), sqlc.arg(conn_id), sqlc.narg(rd_session_id)::numeric,
        sqlc.narg(client_ip)::inet, sqlc.arg(now), sqlc.arg(now))
ON CONFLICT (device_id, conn_id) WHERE ended_at IS NULL DO NOTHING;

-- name: AuthRemoteSession :exec
-- Records the auth details on the open session on conn_id, opening it first
-- when there is none (the auth record arrived before "new", or "new" was lost).
INSERT INTO remote_sessions (device_id, conn_id, rd_session_id, peer_rustdesk_id, peer_name, type,
                             started_at, authed_at, conn_seen_at)
VALUES (sqlc.arg(device_id), sqlc.arg(conn_id), sqlc.narg(rd_session_id)::numeric,
        sqlc.arg(peer_rustdesk_id), sqlc.arg(peer_name), sqlc.narg(type)::smallint,
        sqlc.arg(now), sqlc.arg(now), sqlc.arg(now))
-- A later auth record on the same session fills in what it carries but never
-- erases what an earlier one stored: a null type or an empty peer keeps the
-- stored value.
ON CONFLICT (device_id, conn_id) WHERE ended_at IS NULL DO UPDATE SET
    rd_session_id    = COALESCE(EXCLUDED.rd_session_id, remote_sessions.rd_session_id),
    peer_rustdesk_id = COALESCE(NULLIF(EXCLUDED.peer_rustdesk_id, ''), remote_sessions.peer_rustdesk_id),
    peer_name        = COALESCE(NULLIF(EXCLUDED.peer_name, ''), remote_sessions.peer_name),
    type             = COALESCE(EXCLUDED.type, remote_sessions.type),
    authed_at        = EXCLUDED.authed_at;

-- name: CloseRemoteSession :exec
UPDATE remote_sessions SET ended_at = sqlc.arg(now)::timestamptz,
    end_reason = CASE WHEN disconnect_requested_at IS NULL THEN 'closed' ELSE 'disconnected' END
WHERE device_id = sqlc.arg(device_id) AND conn_id = sqlc.arg(conn_id) AND ended_at IS NULL;

-- name: TouchRemoteSessionConns :exec
-- Marks the device's open sessions on the conns its heartbeat reported as
-- seen now.
UPDATE remote_sessions SET conn_seen_at = sqlc.arg(now)
WHERE device_id = sqlc.arg(device_id) AND ended_at IS NULL
  AND conn_id = ANY (sqlc.arg(conns)::integer[])
  AND EXISTS (SELECT 1 FROM devices WHERE id = sqlc.arg(device_id) AND uuid = sqlc.arg(dev_uuid)
              AND state IN ('pending', 'approved'));

-- name: EndStaleRemoteSessions :exec
-- Ends, as stale, the device's open sessions missing from conns and not seen
-- since before cutoff. They end when they were last seen; a session with a
-- disconnect request ends as disconnected instead.
UPDATE remote_sessions SET ended_at = conn_seen_at,
    end_reason = CASE WHEN disconnect_requested_at IS NULL THEN 'stale' ELSE 'disconnected' END
WHERE device_id = sqlc.arg(device_id) AND ended_at IS NULL
  AND conn_id <> ALL (sqlc.arg(conns)::integer[])
  AND conn_seen_at < sqlc.arg(cutoff)
  AND EXISTS (SELECT 1 FROM devices WHERE id = sqlc.arg(device_id) AND uuid = sqlc.arg(dev_uuid)
              AND state IN ('pending', 'approved'));

-- name: ListRemoteSessions :many
-- Newest first, keyset-paginated on (started_at, id). Every narg filter is
-- optional; since is inclusive and until exclusive (on started_at), and
-- authenticated is whether authed_at is set.
SELECT s.id, s.device_id, d.alias, d.hostname, d.rustdesk_id,
       s.peer_rustdesk_id, s.peer_name, s.type, s.client_ip,
       s.started_at, s.authed_at, s.ended_at, s.end_reason, s.disconnect_requested_at
FROM remote_sessions s
JOIN devices d ON d.id = s.device_id
WHERE (sqlc.narg('device_id')::uuid IS NULL OR s.device_id = sqlc.narg('device_id'))
  AND (sqlc.narg('scope_user')::uuid IS NULL OR s.device_id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid)))
  AND (sqlc.narg('active')::boolean IS NULL OR (s.ended_at IS NULL) = sqlc.narg('active'))
  AND (sqlc.narg('authenticated')::boolean IS NULL OR (s.authed_at IS NOT NULL) = sqlc.narg('authenticated'))
  AND (sqlc.narg('since')::timestamptz IS NULL OR s.started_at >= sqlc.narg('since'))
  AND (sqlc.narg('until')::timestamptz IS NULL OR s.started_at < sqlc.narg('until'))
  AND (sqlc.narg('cursor_at')::timestamptz IS NULL
       OR (s.started_at, s.id) < (sqlc.narg('cursor_at')::timestamptz, sqlc.narg('cursor_id')::uuid))
ORDER BY s.started_at DESC, s.id DESC
LIMIT sqlc.arg('row_limit')::int;

-- name: RemoteSessionsPerDay :many
-- Authenticated sessions started since range_start, bucketed by their start
-- day in tz, labelled YYYY-MM-DD whatever the connection's DateStyle. An open
-- session lasts until now. A connection whose peer never authenticated is not
-- a session for any statistic.
SELECT to_char(s.started_at AT TIME ZONE sqlc.arg('tz')::text, 'YYYY-MM-DD')::text AS day,
       count(*)::bigint AS count,
       COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, sqlc.arg('now')::timestamptz) - s.started_at)), 0)), 0)::bigint AS total_seconds
FROM remote_sessions s
WHERE s.started_at >= sqlc.arg('range_start')::timestamptz AND s.authed_at IS NOT NULL
  AND (sqlc.narg('scope_user')::uuid IS NULL OR s.device_id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid)))
GROUP BY 1;

-- name: RemoteSessionsTopDevices :many
-- By authenticated session time since range_start.
SELECT s.device_id, d.alias, d.hostname, d.rustdesk_id,
       count(*)::bigint AS count,
       COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, sqlc.arg('now')::timestamptz) - s.started_at)), 0)), 0)::bigint AS total_seconds
FROM remote_sessions s
JOIN devices d ON d.id = s.device_id
WHERE s.started_at >= sqlc.arg('range_start')::timestamptz AND s.authed_at IS NOT NULL
  AND (sqlc.narg('scope_user')::uuid IS NULL OR s.device_id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid)))
GROUP BY s.device_id, d.alias, d.hostname, d.rustdesk_id
ORDER BY total_seconds DESC, s.device_id
LIMIT 5;

-- name: CloseStaleRemoteSessions :execrows
-- Ends, as stale, every open session whose device has not reported its
-- conn_id since before cutoff, as of the last sighting. It catches devices
-- that went away without a close and without further heartbeats.
UPDATE remote_sessions SET ended_at = conn_seen_at,
    end_reason = CASE WHEN disconnect_requested_at IS NULL THEN 'stale' ELSE 'disconnected' END
WHERE ended_at IS NULL AND conn_seen_at < $1;

-- name: LockRemoteSession :one
SELECT id, device_id, conn_id, ended_at, disconnect_requested_at
FROM remote_sessions WHERE id = $1 FOR UPDATE;

-- name: RequestRemoteSessionDisconnect :execrows
-- Only the first request on an open session counts: later ones keep its time
-- and requester.
UPDATE remote_sessions SET disconnect_requested_at = sqlc.arg(now), disconnect_requested_by = sqlc.arg(requested_by)
WHERE id = sqlc.arg(id) AND ended_at IS NULL AND disconnect_requested_at IS NULL;

-- name: GetRemoteSession :one
SELECT s.id, s.device_id, d.alias, d.hostname, d.rustdesk_id,
       s.peer_rustdesk_id, s.peer_name, s.type, s.client_ip,
       s.started_at, s.authed_at, s.ended_at, s.end_reason, s.disconnect_requested_at
FROM remote_sessions s
JOIN devices d ON d.id = s.device_id
WHERE s.id = $1;

-- name: PendingDisconnectConns :many
-- The conn_ids of the device's open sessions with a disconnect request that
-- its heartbeat still reports.
SELECT conn_id FROM remote_sessions
WHERE device_id = sqlc.arg(device_id) AND ended_at IS NULL AND disconnect_requested_at IS NOT NULL
  AND conn_id = ANY (sqlc.arg(conns)::integer[])
  AND EXISTS (SELECT 1 FROM devices WHERE id = sqlc.arg(device_id) AND uuid = sqlc.arg(dev_uuid)
              AND state IN ('pending', 'approved'))
ORDER BY conn_id;
