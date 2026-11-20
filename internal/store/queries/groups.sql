-- name: LockGroupTree :exec
-- Serialises changes to the group tree (create, move, delete) until the
-- transaction ends, so two concurrent moves cannot together form a cycle that
-- neither saw. The key is an arbitrary constant reserved for the tree.
SELECT pg_advisory_xact_lock(8150372946002);

-- name: ListGroups :many
SELECT * FROM device_groups ORDER BY name, id;

-- name: ListVisibleGroups :many
SELECT g.id, parent.id AS parent_id, g.name, g.policy_id
FROM device_groups g
LEFT JOIN device_groups parent ON parent.id = g.parent_id
    AND parent.id IN (SELECT visible_groups(sqlc.arg('user_id')::uuid))
WHERE g.id IN (SELECT visible_groups(sqlc.arg('user_id')::uuid))
ORDER BY g.name, g.id;

-- name: GetGroupForUpdate :one
SELECT * FROM device_groups WHERE id = $1 FOR UPDATE;

-- name: CreateGroup :one
INSERT INTO device_groups (parent_id, name) VALUES ($1, $2)
RETURNING *;

-- name: RenameGroup :one
UPDATE device_groups SET name = $2 WHERE id = $1
RETURNING *;

-- name: MoveGroup :one
UPDATE device_groups SET parent_id = $2 WHERE id = $1
RETURNING *;

-- name: DeleteGroup :exec
DELETE FROM device_groups WHERE id = $1;

-- name: GroupInUse :one
-- Whether the group has child groups or devices.
SELECT (EXISTS (SELECT 1 FROM device_groups WHERE parent_id = sqlc.arg(id)::uuid)
     OR EXISTS (SELECT 1 FROM devices WHERE group_id = sqlc.arg(id)::uuid))::boolean AS in_use;

-- name: GroupIsSelfOrAncestor :one
-- Walks up the tree from start and reports whether target is start or one of
-- its ancestors. UNION (not UNION ALL) stops the walk should a cycle exist.
WITH RECURSIVE up (id, parent_id) AS (
    SELECT g.id, g.parent_id FROM device_groups g WHERE g.id = sqlc.arg(start)::uuid
    UNION
    SELECT g.id, g.parent_id FROM device_groups g JOIN up ON g.id = up.parent_id
)
SELECT EXISTS (SELECT 1 FROM up WHERE up.id = sqlc.arg(target)::uuid)::boolean AS found;
