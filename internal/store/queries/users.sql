-- name: CreateUser :one
INSERT INTO users (username, display_name, email, role, password_hash, totp_required)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetUserByUsername :one
-- username is citext, so the match is case-insensitive.
SELECT * FROM users WHERE username = $1;

-- name: GetUserByID :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserByOIDC :one
SELECT * FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2;

-- name: GetUsersByEmail :many
SELECT * FROM users WHERE lower(email) = lower(sqlc.arg(email)::text) AND email <> ''
    AND email_unverified = false LIMIT 2;

-- name: LinkUserOIDC :one
UPDATE users SET oidc_issuer = sqlc.arg(issuer), oidc_subject = sqlc.arg(subject), updated_at = now()
WHERE id = sqlc.arg(id) AND oidc_issuer IS NULL AND oidc_subject IS NULL RETURNING *;

-- name: CreateOIDCUser :one
INSERT INTO users (username, display_name, email, email_unverified, role, password_hash, oidc_issuer, oidc_subject)
VALUES (sqlc.arg(username), sqlc.arg(display_name), sqlc.arg(email), sqlc.arg(email_unverified), sqlc.arg(role), NULL,
        sqlc.arg(issuer), sqlc.arg(subject))
ON CONFLICT (username) DO NOTHING RETURNING *;

-- name: FillOIDCEmail :execrows
UPDATE users SET email = sqlc.arg(email), email_unverified = sqlc.arg(email_unverified), updated_at = now()
WHERE id = sqlc.arg(id) AND email = '';

-- name: SetOIDCRole :one
UPDATE users SET role = sqlc.arg(role), updated_at = now() WHERE id = sqlc.arg(id) RETURNING *;

-- name: SetUserAvatar :exec
UPDATE users SET avatar = sqlc.arg(avatar), avatar_type = sqlc.arg(avatar_type),
    avatar_updated_at = now(), updated_at = now() WHERE id = sqlc.arg(id);

-- name: GetUserAvatar :one
SELECT avatar, avatar_type FROM users WHERE id = $1;

-- name: UnlinkUserOIDC :one
UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL, updated_at = now()
WHERE id = $1 RETURNING *;

-- name: RecordLoginFailure :one
-- The increment happens in SQL so concurrent failures are all counted.
UPDATE users SET failed_logins = CASE
    WHEN last_failed_login_at IS NULL OR last_failed_login_at <= sqlc.arg(now)::timestamptz - interval '1 hour' THEN 1
    ELSE failed_logins + 1 END,
    last_failed_login_at = sqlc.arg(now)::timestamptz
WHERE id = sqlc.arg(id)
RETURNING failed_logins;

-- name: SetLockedUntil :one
-- Extends the lock to until; GREATEST ignores a NULL locked_until, and keeps a
-- longer lock set by a concurrent failure. The row only matches while
-- failed_logins is still at least the count that earned the lock, so a
-- success that reset the count in between is not followed by a lock.
UPDATE users SET locked_until = GREATEST(locked_until, sqlc.arg(until)::timestamptz)
WHERE id = sqlc.arg(id) AND failed_logins >= sqlc.arg(failures)::int
RETURNING locked_until;

-- name: ResetLoginFailures :execrows
-- Clears the failure count and lock after a correct password. It matches no
-- row when the account is locked at now, which happens when a concurrent
-- failure locked it while the password was being verified.
UPDATE users SET failed_logins = 0, locked_until = NULL, last_failed_login_at = NULL
WHERE id = sqlc.arg(id)
  AND (locked_until IS NULL OR locked_until <= sqlc.arg(now)::timestamptz);

-- name: CountActiveOwners :one
-- Locks the active owner rows, so call it inside the transaction that
-- disables or demotes an owner. (FOR UPDATE cannot be combined with count
-- directly, hence the subquery.)
SELECT count(*) FROM (
    SELECT id FROM users WHERE role = 'owner' AND status = 'active' FOR UPDATE
) AS owners;

-- name: SetTOTP :exec
-- Stores the sealed TOTP secret, or clears it when totp_secret_enc is NULL.
-- totp_last_step is left alone: it only ever grows, so no code can be
-- accepted twice whatever happens to the secret.
UPDATE users SET totp_secret_enc = $2, totp_failed_logins = 0, totp_locked_until = NULL, updated_at = now()
WHERE id = $1;

-- name: SetTOTPLastStep :execrows
-- Records the TOTP step just accepted. It matches only when step is greater
-- than the stored one, so of two concurrent uses of a code exactly one wins;
-- the caller must treat 0 rows as a rejected code.
UPDATE users SET totp_last_step = sqlc.arg(step), totp_failed_logins = 0, totp_locked_until = NULL
WHERE id = sqlc.arg(id) AND totp_last_step < sqlc.arg(step);

-- name: RecordTOTPFailure :exec
-- The caller holds the user row lock and audits in the same transaction.
UPDATE users SET totp_failed_logins = totp_failed_logins + 1,
    totp_locked_until = sqlc.narg(until)::timestamptz
WHERE id = sqlc.arg(id);

-- name: GetFirstOwner :one
-- The setup wizard's owner. Until setup completes, only the wizard creates
-- users, so this is the one it made.
SELECT * FROM users WHERE role = 'owner' ORDER BY created_at, id LIMIT 1;

-- name: ReplaceSetupOwner :exec
-- Re-running the wizard's owner step before setup completes overwrites the
-- owner it created, and drops any TOTP secret so enrollment starts over.
UPDATE users SET username = $2, display_name = $3, email = $4, password_hash = $5,
    totp_secret_enc = NULL, totp_required = true, status = 'active',
    failed_logins = 0, locked_until = NULL, last_failed_login_at = NULL,
    totp_failed_logins = 0, totp_locked_until = NULL, updated_at = now()
WHERE id = $1;

-- name: SetPasswordHash :exec
UPDATE users SET password_hash = $2, updated_at = now()
WHERE id = $1;

-- name: ListUsers :many
-- By username (citext, so case-insensitively), keyset-paginated on it.
SELECT * FROM users
WHERE (sqlc.narg('after_username')::citext IS NULL OR username > sqlc.narg('after_username')::citext)
ORDER BY username
LIMIT sqlc.arg('row_limit')::int;

-- name: GetUserByIDForUpdate :one
SELECT * FROM users WHERE id = $1 FOR UPDATE;

-- name: UpdateUserProfile :one
UPDATE users SET display_name = $2, email = $3, role = $4, status = $5, totp_required = $6,
    email_unverified = CASE WHEN sqlc.arg(email_edited)::boolean THEN false ELSE email_unverified END,
    updated_at = now()
WHERE id = $1
RETURNING *;

-- name: UnlockUser :exec
-- Operator recovery (ferricade user unlock): clears the failure count and lock.
UPDATE users SET failed_logins = 0, locked_until = NULL, last_failed_login_at = NULL,
    totp_failed_logins = 0, totp_locked_until = NULL, updated_at = now()
WHERE id = $1;

-- name: ResetUserTOTP :exec
-- Operator recovery (ferricade user reset-totp): removes the TOTP secret and
-- restarts totp_last_step, for a fresh enrollment. totp_required is kept.
UPDATE users SET totp_secret_enc = NULL, totp_last_step = 0,
    totp_failed_logins = 0, totp_locked_until = NULL, updated_at = now()
WHERE id = $1;
