-- name: InsertFleetSnapshot :exec
-- Does nothing when the slot already has a snapshot.
INSERT INTO fleet_snapshots (at, approved, online, pending, sessions)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (at) DO NOTHING;

-- name: CountOpenSessionsOfApproved :one
-- Open, authenticated sessions: a connection whose peer has not (yet)
-- authenticated is not counted.
SELECT count(*)::integer FROM remote_sessions s
JOIN devices d ON d.id = s.device_id
WHERE d.server_id = $1 AND d.state = 'approved' AND s.ended_at IS NULL AND s.authed_at IS NOT NULL;

-- name: FleetHistory :many
-- Snapshots since range_start grouped into step-second buckets aligned to
-- the epoch: rounded mean of the device counts, peak of the sessions.
SELECT date_bin(make_interval(secs => sqlc.arg(step_seconds)::integer), at, 'epoch'::timestamptz)::timestamptz AS bucket,
       round(avg(approved))::integer AS approved,
       round(avg(online))::integer AS online,
       round(avg(pending))::integer AS pending,
       max(sessions)::integer AS sessions
FROM fleet_snapshots
WHERE at >= sqlc.arg(range_start)::timestamptz
GROUP BY 1
ORDER BY 1;

-- name: DeleteOldFleetSnapshots :execrows
DELETE FROM fleet_snapshots WHERE at < $1;

-- name: DeleteOldRemoteSessions :execrows
DELETE FROM remote_sessions WHERE ended_at < $1;

-- name: DeleteOldSeenNonces :execrows
DELETE FROM seen_nonces WHERE seen_at < $1;

-- name: SummaryDevices :many
-- Every device, for the dashboard summary; the counting is done in Go
-- against the tracker's online state.
SELECT id, rustdesk_id, state, alias, hostname, os, client_version, group_id, first_seen_at, last_seen_at
FROM devices
WHERE (sqlc.narg('scope_user')::uuid IS NULL OR id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid)));

-- name: SummaryGroups :many
SELECT id, name FROM device_groups
WHERE (sqlc.narg('scope_user')::uuid IS NULL OR id IN (SELECT visible_groups(sqlc.narg('scope_user')::uuid)));

-- name: SummaryOpenAlerts :many
SELECT a.created_at, d.id AS device_id, d.rustdesk_id, d.alias, d.hostname
FROM device_alerts a
JOIN devices d ON d.id = a.device_id
WHERE a.resolved_at IS NULL
  AND (sqlc.narg('scope_user')::uuid IS NULL OR d.id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid)));

-- name: CountOpenSessionsOfAllApproved :one
-- Open, authenticated sessions, as CountOpenSessionsOfApproved.
SELECT count(*)::integer FROM remote_sessions s
JOIN devices d ON d.id = s.device_id
WHERE d.state = 'approved' AND s.ended_at IS NULL AND s.authed_at IS NOT NULL
  AND (sqlc.narg('scope_user')::uuid IS NULL OR d.id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid)));

-- name: CountDevicesByState :many
SELECT state, count(*)::integer AS count FROM devices GROUP BY state;

-- name: FleetMapDevices :many
SELECT d.id,
       COALESCE(NULLIF(d.alias, ''), NULLIF(d.hostname, ''), d.rustdesk_id) AS name,
       CASE WHEN sqlc.narg('scope_user')::uuid IS NULL
                  OR d.group_id IN (SELECT visible_groups(sqlc.narg('scope_user')::uuid))
            THEN d.group_id::text ELSE NULL END AS group_id,
       EXISTS (SELECT 1 FROM device_alerts a WHERE a.device_id = d.id AND a.resolved_at IS NULL) AS has_alert,
       d.rustdesk_id
FROM devices d
WHERE d.state = 'approved'
  AND (sqlc.narg('scope_user')::uuid IS NULL OR d.id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid)))
ORDER BY lower(COALESCE(NULLIF(d.alias, ''), NULLIF(d.hostname, ''), d.rustdesk_id)), d.id
LIMIT 2001;
