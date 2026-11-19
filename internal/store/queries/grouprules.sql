-- name: ListGroupRules :many
SELECT r.id, r.group_id, r.pattern, r.created_at, r.created_by,
       u.display_name AS creator_name
FROM group_rules r LEFT JOIN users u ON u.id = r.created_by
ORDER BY r.group_id, r.pattern, r.id;

-- name: MatchGroupRules :many
SELECT id, group_id, pattern FROM group_rules ORDER BY group_id, pattern, id;

-- name: CountGroupRules :one
SELECT count(*) FROM group_rules WHERE group_id = $1;

-- name: AddGroupRule :one
INSERT INTO group_rules (group_id, pattern, created_by) VALUES ($1, $2, $3) RETURNING *;

-- name: RemoveGroupRule :one
DELETE FROM group_rules WHERE group_id = $1 AND id = $2 RETURNING pattern;

-- name: RulePreviewDevices :many
SELECT id, rustdesk_id, hostname, alias, state, group_id
FROM devices WHERE state IN ('pending', 'approved') ORDER BY hostname, id;

-- name: OpenGroupConflict :exec
INSERT INTO device_alerts (device_id, kind, details)
VALUES ($1, 'group_conflict', $2)
ON CONFLICT (device_id, kind) WHERE resolved_at IS NULL
DO UPDATE SET details = EXCLUDED.details;

-- name: ResolveGroupConflict :execrows
UPDATE device_alerts SET resolved_at = now(), resolved_by = $2
WHERE device_id = $1 AND kind = 'group_conflict' AND resolved_at IS NULL;

-- name: AlertGroupRefs :many
SELECT id, name FROM device_groups WHERE id = ANY(sqlc.arg(group_ids)::uuid[]) ORDER BY name, id;

-- name: SetRuleDeviceGroup :exec
UPDATE devices SET group_id = $2, updated_at = now() WHERE id = $1;

-- name: LockAutoSort :exec
SELECT pg_advisory_xact_lock(hashtext('ferricade.auto_sort'));

-- name: SetAutoSortLockTimeout :exec
SET LOCAL lock_timeout = '5s';

-- name: LockAutoSortDeviceChanges :exec
-- Approval locks a single device without taking the auto-sort advisory lock.
-- Block concurrent device writers and row lockers before taking row locks, so
-- an approval cannot interleave with the fleet snapshot and its changes. Plain
-- reads continue. EXCLUSIVE also lets existing row lockers finish before this
-- run, avoiding a row-lock/table-lock upgrade deadlock with device transitions.
LOCK TABLE devices IN EXCLUSIVE MODE;

-- name: AutoSortDevices :many
SELECT id, rustdesk_id, hostname, alias, state, group_id
FROM devices WHERE state = 'approved' ORDER BY hostname COLLATE "C", id;

-- name: AutoSortDevicesForUpdate :many
SELECT id, rustdesk_id, hostname, alias, state, group_id
FROM devices WHERE state = 'approved' ORDER BY hostname COLLATE "C", id FOR UPDATE;

-- name: AutoSortRulesAndGroups :many
-- Include groups without rules so manual source placements have names too.
SELECT g.id AS group_id, g.name, r.pattern
FROM group_rules r RIGHT JOIN device_groups g ON g.id = r.group_id
ORDER BY g.id, r.pattern;

-- name: RulePreviewGroup :one
SELECT id, name FROM device_groups WHERE id = $1;

-- name: ListConflictAlertGroups :many
SELECT a.id AS alert_id, g.id, g.name
FROM device_alerts a
JOIN device_groups g ON g.id::text IN (SELECT jsonb_array_elements_text(a.details->'group_ids'))
WHERE a.device_id = ANY(sqlc.arg(device_ids)::uuid[])
  AND a.kind = 'group_conflict' AND a.resolved_at IS NULL
ORDER BY g.name, g.id;

-- name: LockGroupConflictAlerts :many
SELECT a.id AS alert_id, a.device_id, a.details, d.hostname
FROM device_alerts a JOIN devices d ON d.id = a.device_id
WHERE a.kind = 'group_conflict' AND a.resolved_at IS NULL
  AND a.details->'group_ids' ? sqlc.arg(group_id)::text
ORDER BY a.device_id, a.id
FOR UPDATE OF a, d;

-- name: UpdateGroupConflictDetails :exec
UPDATE device_alerts SET details = $2
WHERE id = $1 AND kind = 'group_conflict' AND resolved_at IS NULL;

-- name: ResolveGroupConflictAlert :execrows
UPDATE device_alerts SET resolved_at = now(), resolved_by = $2
WHERE id = $1 AND kind = 'group_conflict' AND resolved_at IS NULL;

-- name: MoveAutoSortDevices :exec
WITH moves AS (
    SELECT unnest(sqlc.arg(device_ids)::uuid[]) AS id,
           unnest(sqlc.arg(group_ids)::uuid[]) AS group_id
)
UPDATE devices d SET group_id = m.group_id, updated_at = now()
FROM moves m WHERE d.id = m.id;

-- name: AuditAutoSortMoves :exec
WITH moves AS (
    SELECT unnest(sqlc.arg(device_ids)::uuid[]) AS id,
           unnest(sqlc.arg(details)::text[]) AS details
)
INSERT INTO audit_events(actor_user_id, actor_ip, action, target_type, target_id, details)
SELECT sqlc.narg(actor_id)::uuid, sqlc.arg(actor_ip)::inet,
       'device.updated', 'device', m.id::text, m.details::jsonb FROM moves m;

-- name: UpsertAutoSortConflicts :exec
WITH conflicts AS (
    SELECT unnest(sqlc.arg(device_ids)::uuid[]) AS id,
           unnest(sqlc.arg(details)::text[]) AS details
)
INSERT INTO device_alerts (device_id, kind, details)
SELECT c.id, 'group_conflict', c.details::jsonb FROM conflicts c
ON CONFLICT (device_id, kind) WHERE resolved_at IS NULL
DO UPDATE SET details = EXCLUDED.details
WHERE device_alerts.details IS DISTINCT FROM EXCLUDED.details;

-- name: ResolveStaleAutoSortConflicts :execrows
UPDATE device_alerts SET resolved_at = now(), resolved_by = sqlc.arg(actor_id)
WHERE kind = 'group_conflict' AND resolved_at IS NULL
  AND device_id = ANY(sqlc.arg(approved_ids)::uuid[])
  AND NOT (device_id = ANY(sqlc.arg(conflict_ids)::uuid[]));
