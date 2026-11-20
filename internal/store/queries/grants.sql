-- name: ListUserGrants :many
SELECT group_id, device_id FROM user_grants WHERE user_id = $1 ORDER BY created_at, id;

-- name: ListVisibleDeviceIDs :many
SELECT visible_devices(sqlc.arg('user_id')::uuid);

-- name: ListVisibleGroupIDs :many
SELECT visible_groups(sqlc.arg('user_id')::uuid);

-- name: DeleteUserGrants :exec
DELETE FROM user_grants WHERE user_id = $1;

-- name: InsertUserGroupGrant :exec
INSERT INTO user_grants (user_id, group_id, created_by) VALUES ($1, $2, $3);

-- name: InsertUserDeviceGrant :exec
INSERT INTO user_grants (user_id, device_id, created_by) VALUES ($1, $2, $3);

-- name: InsertUserGroupGrants :exec
INSERT INTO user_grants (user_id, group_id, created_by)
SELECT $1, unnest($2::uuid[]), $3;

-- name: InsertUserDeviceGrants :exec
INSERT INTO user_grants (user_id, device_id, created_by)
SELECT $1, unnest($2::uuid[]), $3;

-- name: ExistingGroupIDs :many
SELECT id FROM device_groups WHERE id = ANY(sqlc.arg('ids')::uuid[]);

-- name: ExistingDeviceIDs :many
SELECT id FROM devices WHERE id = ANY(sqlc.arg('ids')::uuid[]);

-- name: NotifyGrantsChanged :exec
SELECT pg_notify('ferricade_events', json_build_object('kind', 'grants', 'user_id', sqlc.arg('user_id')::uuid)::text);
