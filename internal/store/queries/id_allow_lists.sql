-- name: GetGlobalIDAllowList :one
SELECT ids FROM global_id_allow_list WHERE id = true;

-- name: LockGlobalIDAllowList :one
SELECT ids FROM global_id_allow_list WHERE id = true FOR UPDATE;

-- name: SetGlobalIDAllowList :exec
UPDATE global_id_allow_list SET ids = sqlc.arg(ids)::text[] WHERE id = true;

-- name: GetGroupIDAllowList :one
SELECT id_allow_list FROM device_groups WHERE id = $1;

-- name: LockGroupIDAllowList :one
SELECT id_allow_list FROM device_groups WHERE id = $1 FOR UPDATE;

-- name: SetGroupIDAllowList :exec
UPDATE device_groups SET id_allow_list = sqlc.arg(ids)::text[] WHERE id = sqlc.arg(id)::uuid;

-- name: GetDeviceIDAllowList :one
SELECT id_allow_list FROM devices WHERE id = $1;

-- name: LockDeviceIDAllowList :one
SELECT id_allow_list FROM devices WHERE id = $1 FOR UPDATE;

-- name: SetDeviceIDAllowList :exec
UPDATE devices SET id_allow_list = sqlc.arg(ids)::text[] WHERE id = sqlc.arg(id)::uuid;

-- name: ListEffectiveDeviceIDAllowList :many
WITH RECURSIVE device AS (
    SELECT id, group_id, id_allow_list FROM devices WHERE id = sqlc.arg(device_id)::uuid
), groups AS (
    SELECT g.id, g.parent_id, g.name, g.id_allow_list, 0 AS depth
    FROM device_groups g JOIN device d ON g.id = d.group_id
    UNION ALL
    SELECT parent.id, parent.parent_id, parent.name, parent.id_allow_list, child.depth + 1
    FROM device_groups parent JOIN groups child ON parent.id = child.parent_id
), entries AS (
    SELECT value::text AS id, 'global'::text AS source, NULL::uuid AS group_id,
           NULL::text AS group_name, 0 AS source_order, 0 AS depth, ordinal::int AS ordinal
    FROM global_id_allow_list g CROSS JOIN LATERAL unnest(g.ids) WITH ORDINALITY AS x(value, ordinal)
    WHERE g.id = true
    UNION ALL
    SELECT value::text, 'group', g.id, g.name, 1, g.depth, ordinal::int
    FROM groups g CROSS JOIN LATERAL unnest(g.id_allow_list) WITH ORDINALITY AS x(value, ordinal)
    UNION ALL
    SELECT value::text, 'device', NULL::uuid, NULL::text, 2, 0, ordinal::int
    FROM device d CROSS JOIN LATERAL unnest(d.id_allow_list) WITH ORDINALITY AS x(value, ordinal)
)
SELECT DISTINCT ON (lower(id), source) id, source, group_id, group_name, source_order, depth, ordinal
FROM entries
ORDER BY lower(id), source, depth, ordinal;
