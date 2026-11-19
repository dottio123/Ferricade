-- name: GetUserPreferences :one
SELECT prefs FROM user_preferences WHERE user_id = $1;

-- name: PutUserPreferences :exec
INSERT INTO user_preferences (user_id, prefs, updated_at) VALUES ($1, $2, $3)
ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = EXCLUDED.updated_at;

-- name: ApprovedDeviceIDs :many
-- Which of the given devices exist and are approved; for a User (scope_user
-- set) only those it can see, so a hidden device answers like an unknown one.
SELECT id FROM devices WHERE id = ANY(sqlc.arg(ids)::uuid[]) AND state = 'approved'
  AND (sqlc.narg('scope_user')::uuid IS NULL OR id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid)));
