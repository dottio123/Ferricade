-- name: GetClientDevice :one
-- What the client API needs to decide how to treat a heartbeat or sysinfo.
-- has_sysinfo is false until the first sysinfo is stored.
SELECT id, uuid, state, (presets IS NOT NULL)::boolean AS has_sysinfo
FROM devices
WHERE server_id = $1 AND rustdesk_id = $2;

-- name: CountPendingDevices :one
SELECT count(*) FROM devices WHERE server_id = $1 AND state = 'pending';

-- name: LockDeviceEnrollment :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(server_id)::uuid::text, 0));

-- name: EnrollDevice :one
-- Returns no row when the device already exists (for example when a
-- concurrent request enrolled it first).
INSERT INTO devices (server_id, rustdesk_id, uuid)
VALUES ($1, $2, $3)
ON CONFLICT (server_id, rustdesk_id) DO NOTHING
RETURNING id;

-- name: StoreDeviceSysinfo :execrows
-- Matches only while the device still has this uuid and is pending or
-- approved, so a concurrent reject, archive or re-pin wins.
UPDATE devices
SET hostname = sqlc.arg(hostname), os = sqlc.arg(os), cpu = sqlc.arg(cpu),
    memory = sqlc.arg(memory), client_version = sqlc.arg(client_version),
    username = sqlc.arg(username), presets = sqlc.arg(presets), updated_at = now()
WHERE id = sqlc.arg(id) AND uuid = sqlc.arg(uuid) AND state IN ('pending', 'approved');

-- name: OpenUUIDMismatchAlert :one
-- Returns no row when the device already has an open uuid_mismatch alert.
INSERT INTO device_alerts (device_id, kind, details)
VALUES ($1, 'uuid_mismatch', $2)
ON CONFLICT (device_id, kind) WHERE resolved_at IS NULL DO NOTHING
RETURNING id;

-- name: UpdateLastSeen :exec
-- Batch-writes heartbeat times from the online tracker. Only pending and
-- approved devices are touched: a heartbeat can race an admin reject or
-- archive, and the reject must not be followed by a fresh last_seen_at.
UPDATE devices AS d
SET last_seen_at = v.seen_at
FROM (
    SELECT unnest(sqlc.arg(rustdesk_ids)::text[]) AS rustdesk_id,
           unnest(sqlc.arg(seen_ats)::timestamptz[]) AS seen_at
) AS v
WHERE d.server_id = sqlc.arg(server_id)
  AND d.rustdesk_id = v.rustdesk_id
  AND d.state IN ('pending', 'approved');

-- name: ListApprovedRustdeskIDs :many
-- The approved devices the online tracker asks hbbs about.
SELECT rustdesk_id FROM devices
WHERE server_id = $1 AND state = 'approved'
ORDER BY rustdesk_id;

-- name: ListDeviceSortCandidates :many
-- The tracker uses RustDesk IDs, including pending devices and direct grants.
SELECT id, rustdesk_id FROM devices
WHERE (sqlc.narg('scope_user')::uuid IS NULL OR id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid)));

-- name: ListDevices :many
-- Compute the same tuple for the page and cursor. Group ordering uses the
-- separate query below so other sorts do not read group names. Desc reverses
-- the entire tuple. Select the narrow page before loading full device rows.
WITH RECURSIVE group_tree(id) AS (
    SELECT sqlc.narg('group_id')::uuid WHERE sqlc.arg('subgroups')::boolean
    UNION
    SELECT g.id FROM device_groups g JOIN group_tree parent ON g.parent_id = parent.id
    WHERE sqlc.narg('scope_user')::uuid IS NULL
       OR g.id IN (SELECT group_id FROM user_grants WHERE user_id = sqlc.narg('scope_user')::uuid)
), keyed AS (
SELECT devices.id, rustdesk_id,
    CASE sqlc.arg('sort_key')::text
        WHEN 'os' THEN os = ''
        ELSE false
    END AS missing,
    CASE sqlc.arg('sort_key')::text
        WHEN 'name' THEN lower(coalesce(nullif(alias,''), nullif(hostname,''), rustdesk_id))
        WHEN 'status' THEN CASE
            WHEN EXISTS (SELECT 1 FROM device_alerts a WHERE a.device_id = devices.id AND a.resolved_at IS NULL) THEN '0'
            WHEN state = 'pending' THEN '1'
            WHEN devices.id = ANY(sqlc.arg('online_ids')::uuid[]) THEN '2'
            ELSE '3' END
        WHEN 'state' THEN CASE state WHEN 'pending' THEN '0' WHEN 'approved' THEN '1' WHEN 'rejected' THEN '2' ELSE '3' END
        WHEN 'os' THEN lower(os)
        ELSE rustdesk_id
    END AS sort_value
FROM devices
WHERE (sqlc.narg('scope_user')::uuid IS NULL OR devices.id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid)))
  AND (sqlc.narg('state')::text IS NULL OR state = sqlc.narg('state'))
  AND (sqlc.narg('group_id')::uuid IS NULL OR
       (sqlc.arg('subgroups')::boolean AND devices.group_id IN (SELECT id FROM group_tree)) OR
       (NOT sqlc.arg('subgroups')::boolean AND devices.group_id = sqlc.narg('group_id')))
  AND (NOT sqlc.arg('ungrouped')::boolean OR devices.group_id IS NULL
       OR (sqlc.narg('scope_user')::uuid IS NOT NULL
           AND devices.group_id NOT IN (SELECT visible_groups(sqlc.narg('scope_user')::uuid))))
  AND (sqlc.narg('tag_id')::uuid IS NULL OR EXISTS (
        SELECT 1 FROM device_tags dt WHERE dt.device_id = devices.id AND dt.tag_id = sqlc.narg('tag_id')))
  AND (sqlc.narg('os_pattern')::text IS NULL OR os ILIKE sqlc.narg('os_pattern'))
  AND (sqlc.narg('q_pattern')::text IS NULL
       OR rustdesk_id ILIKE sqlc.narg('q_pattern') OR alias ILIKE sqlc.narg('q_pattern')
       OR hostname ILIKE sqlc.narg('q_pattern') OR username ILIKE sqlc.narg('q_pattern'))
), page AS (
SELECT k.* FROM keyed k
WHERE sqlc.narg('after_id')::uuid IS NULL
    OR (NOT sqlc.arg('descending')::boolean AND (k.missing, k.sort_value, k.rustdesk_id, k.id) >
        (SELECT c.missing, c.sort_value, c.rustdesk_id, c.id FROM keyed c WHERE c.id = sqlc.narg('after_id')::uuid))
    OR (sqlc.arg('descending')::boolean AND (k.missing, k.sort_value, k.rustdesk_id, k.id) <
        (SELECT c.missing, c.sort_value, c.rustdesk_id, c.id FROM keyed c WHERE c.id = sqlc.narg('after_id')::uuid))
ORDER BY
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.missing END ASC,
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.sort_value END ASC,
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.rustdesk_id END ASC,
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.id END ASC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.missing END DESC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.sort_value END DESC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.rustdesk_id END DESC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.id END DESC
LIMIT sqlc.arg('row_limit')::int
)
SELECT devices.* FROM page k JOIN devices ON devices.id = k.id
ORDER BY
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.missing END ASC,
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.sort_value END ASC,
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.rustdesk_id END ASC,
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.id END ASC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.missing END DESC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.sort_value END DESC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.rustdesk_id END DESC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.id END DESC;

-- name: ListDevicesByGroup :many
-- Keep filters and keyset tie-breakers in step with ListDevices. Group names
-- are joined within the statement, so cursor and page share one snapshot.
-- Hidden group names never enter the tuple.
WITH RECURSIVE group_tree(id) AS (
    SELECT sqlc.narg('group_id')::uuid WHERE sqlc.arg('subgroups')::boolean
    UNION
    SELECT g.id FROM device_groups g JOIN group_tree parent ON g.parent_id = parent.id
    WHERE sqlc.narg('scope_user')::uuid IS NULL
       OR g.id IN (SELECT group_id FROM user_grants WHERE user_id = sqlc.narg('scope_user')::uuid)
), keyed AS (
SELECT devices.id, rustdesk_id,
    CASE sqlc.arg('sort_key')::text
        WHEN 'os' THEN os = ''
        WHEN 'group' THEN g.id IS NULL
        ELSE false
    END AS missing,
    CASE sqlc.arg('sort_key')::text
        WHEN 'name' THEN lower(coalesce(nullif(alias,''), nullif(hostname,''), rustdesk_id))
        WHEN 'status' THEN CASE
            WHEN EXISTS (SELECT 1 FROM device_alerts a WHERE a.device_id = devices.id AND a.resolved_at IS NULL) THEN '0'
            WHEN state = 'pending' THEN '1'
            WHEN devices.id = ANY(sqlc.arg('online_ids')::uuid[]) THEN '2'
            ELSE '3' END
        WHEN 'state' THEN CASE state WHEN 'pending' THEN '0' WHEN 'approved' THEN '1' WHEN 'rejected' THEN '2' ELSE '3' END
        WHEN 'os' THEN lower(os)
        WHEN 'group' THEN coalesce(lower(g.name), '')
        ELSE rustdesk_id
    END AS sort_value
FROM devices
LEFT JOIN device_groups g ON g.id = devices.group_id
    AND (sqlc.narg('scope_user')::uuid IS NULL OR g.id IN (SELECT visible_groups(sqlc.narg('scope_user')::uuid)))
WHERE (sqlc.narg('state')::text IS NULL OR state = sqlc.narg('state'))
  AND (sqlc.narg('scope_user')::uuid IS NULL OR devices.id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid)))
  AND (sqlc.narg('group_id')::uuid IS NULL OR
       (sqlc.arg('subgroups')::boolean AND devices.group_id IN (SELECT id FROM group_tree)) OR
       (NOT sqlc.arg('subgroups')::boolean AND devices.group_id = sqlc.narg('group_id')))
  AND (NOT sqlc.arg('ungrouped')::boolean OR devices.group_id IS NULL
       OR (sqlc.narg('scope_user')::uuid IS NOT NULL
           AND devices.group_id NOT IN (SELECT visible_groups(sqlc.narg('scope_user')::uuid))))
  AND (sqlc.narg('tag_id')::uuid IS NULL OR EXISTS (
        SELECT 1 FROM device_tags dt WHERE dt.device_id = devices.id AND dt.tag_id = sqlc.narg('tag_id')))
  AND (sqlc.narg('os_pattern')::text IS NULL OR os ILIKE sqlc.narg('os_pattern'))
  AND (sqlc.narg('q_pattern')::text IS NULL
       OR rustdesk_id ILIKE sqlc.narg('q_pattern') OR alias ILIKE sqlc.narg('q_pattern')
       OR hostname ILIKE sqlc.narg('q_pattern') OR username ILIKE sqlc.narg('q_pattern'))
), page AS (
SELECT k.* FROM keyed k
WHERE sqlc.narg('after_id')::uuid IS NULL
    OR (NOT sqlc.arg('descending')::boolean AND (k.missing, k.sort_value, k.rustdesk_id, k.id) >
        (SELECT c.missing, c.sort_value, c.rustdesk_id, c.id FROM keyed c WHERE c.id = sqlc.narg('after_id')::uuid))
    OR (sqlc.arg('descending')::boolean AND (k.missing, k.sort_value, k.rustdesk_id, k.id) <
        (SELECT c.missing, c.sort_value, c.rustdesk_id, c.id FROM keyed c WHERE c.id = sqlc.narg('after_id')::uuid))
ORDER BY
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.missing END ASC,
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.sort_value END ASC,
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.rustdesk_id END ASC,
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.id END ASC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.missing END DESC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.sort_value END DESC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.rustdesk_id END DESC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.id END DESC
LIMIT sqlc.arg('row_limit')::int
)
SELECT devices.* FROM page k JOIN devices ON devices.id = k.id
ORDER BY
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.missing END ASC,
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.sort_value END ASC,
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.rustdesk_id END ASC,
    CASE WHEN NOT sqlc.arg('descending')::boolean THEN k.id END ASC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.missing END DESC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.sort_value END DESC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.rustdesk_id END DESC,
    CASE WHEN sqlc.arg('descending')::boolean THEN k.id END DESC;

-- name: GetDevice :one
SELECT * FROM devices WHERE id = $1;

-- name: GetVisibleDevice :one
SELECT * FROM devices WHERE id = sqlc.arg('id') AND id IN (SELECT visible_devices(sqlc.arg('user_id')::uuid));

-- name: GetDeviceForUpdate :one
SELECT * FROM devices WHERE id = $1 FOR UPDATE;

-- name: DeviceHasOpenAccessWindow :one
SELECT EXISTS (SELECT 1 FROM access_windows WHERE device_id = $1 AND closed_at IS NULL);

-- name: UpdateDeviceDetails :one
UPDATE devices SET alias = $2, note = $3, group_id = $4, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: SetDeviceState :one
UPDATE devices SET state = $2, approved_by = $3, approved_at = $4, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteDevice :exec
-- Its tags, alerts and remote sessions go with it (ON DELETE CASCADE).
DELETE FROM devices WHERE id = $1;

-- name: CountDeviceSessions :one
SELECT count(*)::integer AS sessions FROM remote_sessions WHERE device_id = $1;

-- name: SetDeviceUUID :exec
-- Re-pins the device to a new client uuid.
UPDATE devices SET uuid = $2, updated_at = now() WHERE id = $1;

-- name: ListDeviceTags :many
-- The tags of each of device_ids, by name.
SELECT dt.device_id, t.id, t.name, t.color
FROM device_tags dt JOIN tags t ON t.id = dt.tag_id
WHERE dt.device_id = ANY(sqlc.arg(device_ids)::uuid[])
ORDER BY t.name, t.id;

-- name: DeleteDeviceTags :exec
DELETE FROM device_tags WHERE device_id = $1;

-- name: AddDeviceTags :exec
INSERT INTO device_tags (device_id, tag_id)
SELECT sqlc.arg(device_id)::uuid, unnest(sqlc.arg(tag_ids)::uuid[])
ON CONFLICT DO NOTHING;

-- name: ListOpenAlerts :many
-- The unresolved alerts of each of device_ids, oldest first.
SELECT * FROM device_alerts
WHERE device_id = ANY(sqlc.arg(device_ids)::uuid[]) AND resolved_at IS NULL
ORDER BY created_at, id;

-- name: GetOpenAlertForUpdate :one
SELECT * FROM device_alerts
WHERE id = $1 AND device_id = $2 AND resolved_at IS NULL
FOR UPDATE;

-- name: ResolveAlert :exec
UPDATE device_alerts SET resolved_at = $2, resolved_by = $3 WHERE id = $1;

-- name: GetDeviceIDByRustdeskID :one
-- Maps the online tracker's rustdesk_id to the device ID for live events.
SELECT id FROM devices WHERE server_id = $1 AND rustdesk_id = $2;
