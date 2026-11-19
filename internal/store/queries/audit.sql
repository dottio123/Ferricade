-- name: InsertAuditEvent :exec
-- clock_timestamp() rather than the column default now(): now() is fixed for a
-- whole transaction, which would give every event written in one the same
-- timestamp and lose their order.
INSERT INTO audit_events (at, actor_user_id, actor_ip, action, target_type, target_id, details)
VALUES (clock_timestamp(), $1, $2, $3, $4, $5, $6);

-- name: ListAuditEvents :many
-- Newest first, keyset-paginated on (at, id). Every narg filter is optional;
-- since is inclusive and until is exclusive.
SELECT id, at, actor_user_id, actor_ip, action, target_type, target_id, details
FROM audit_events
WHERE (sqlc.narg('action')::text IS NULL OR action = sqlc.narg('action'))
  AND (sqlc.narg('target_id')::text IS NULL OR target_id = sqlc.narg('target_id'))
  AND (sqlc.narg('actor_user_id')::uuid IS NULL OR actor_user_id = sqlc.narg('actor_user_id'))
  AND (NOT sqlc.arg('own_kinds_only')::boolean OR starts_with(action, 'auth.') OR action = 'device.connect_link')
  AND (sqlc.narg('since')::timestamptz IS NULL OR at >= sqlc.narg('since'))
  AND (sqlc.narg('until')::timestamptz IS NULL OR at < sqlc.narg('until'))
  AND (sqlc.narg('cursor_at')::timestamptz IS NULL
       OR (at, id) < (sqlc.narg('cursor_at')::timestamptz, sqlc.narg('cursor_id')::uuid))
ORDER BY at DESC, id DESC
LIMIT sqlc.arg('row_limit')::int;
