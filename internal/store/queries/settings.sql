-- name: GetSetting :one
SELECT value FROM settings WHERE key = $1;

-- name: PutSetting :exec
INSERT INTO settings (key, value) VALUES ($1, $2)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- name: LockSetup :exec
-- Serialises the setup wizard's writes until the transaction ends. The key is
-- an arbitrary constant reserved for setup.
SELECT pg_advisory_xact_lock(8150372946001);

-- name: GetSessionSettings :one
SELECT * FROM session_settings WHERE id = true;

-- name: GetSessionSettingsForShare :one
-- Serialize session creation/rotation with a stricter setting until commit.
SELECT * FROM session_settings WHERE id = true FOR SHARE;

-- name: GetSessionSettingsForUpdate :one
SELECT * FROM session_settings WHERE id = true FOR UPDATE;

-- name: UpdateSessionSettings :one
UPDATE session_settings
SET lifetime = $1, updated_at = $2, updated_by = $3
WHERE id = true
RETURNING *;
