-- name: ListTags :many
-- By name (citext, so case-insensitively), keyset-paginated on it.
SELECT * FROM tags
WHERE (sqlc.narg('after_name')::citext IS NULL OR name > sqlc.narg('after_name')::citext)
  AND (sqlc.narg('scope_user')::uuid IS NULL OR EXISTS (
      SELECT 1 FROM device_tags dt WHERE dt.tag_id = tags.id
      AND dt.device_id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid))))
ORDER BY name
LIMIT sqlc.arg('row_limit')::int;

-- name: GetTagForUpdate :one
SELECT * FROM tags WHERE id = $1 FOR UPDATE;

-- name: CreateTag :one
INSERT INTO tags (name, color) VALUES ($1, $2)
RETURNING *;

-- name: UpdateTag :one
UPDATE tags SET name = $2, color = $3 WHERE id = $1
RETURNING *;

-- name: DeleteTag :one
-- Deleting a tag detaches it from its devices (device_tags cascades); the
-- count of devices it was on is returned for the audit log.
WITH detached AS (
    SELECT count(*) AS devices FROM device_tags WHERE tag_id = sqlc.arg(id)::uuid
), gone AS (
    DELETE FROM tags WHERE id = sqlc.arg(id)::uuid RETURNING id
)
SELECT gone.id, detached.devices FROM gone, detached;
