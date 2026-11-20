-- name: InsertSession :exec
INSERT INTO sessions (id, user_id, csrf_token, mfa_passed, ip, user_agent, created_at, last_seen_at, expires_at, persistent)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);

-- name: GetSession :one
SELECT * FROM sessions WHERE id = $1;

-- name: GetSessionWithUser :one
SELECT s.*, u.username, u.display_name, u.email, u.role,
       (u.totp_secret_enc IS NOT NULL)::boolean AS totp_enrolled,
       u.totp_required, u.status,
       (u.oidc_issuer IS NOT NULL AND u.oidc_subject IS NOT NULL)::boolean AS sso,
       u.avatar_updated_at
FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1;

-- name: TouchSession :execrows
UPDATE sessions SET last_seen_at = $2 WHERE id = $1;

-- name: DeleteSession :execrows
DELETE FROM sessions WHERE id = $1;

-- name: DeleteUserSessions :exec
DELETE FROM sessions WHERE user_id = $1;

-- name: DeleteOtherUserSessions :exec
-- Ends every session of user_id except keep_id.
DELETE FROM sessions WHERE user_id = sqlc.arg(user_id) AND id <> sqlc.arg(keep_id);

-- name: CapSessionLifetimes :exec
UPDATE sessions
SET expires_at = least(expires_at, created_at + sqlc.arg(seconds)::bigint * interval '1 second'),
    persistent = persistent AND NOT sqlc.arg(browser)::boolean;
