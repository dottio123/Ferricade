-- +goose Up
ALTER TABLE users
    ADD COLUMN totp_failed_logins integer NOT NULL DEFAULT 0,
    ADD COLUMN totp_locked_until timestamptz,
    ADD COLUMN last_failed_login_at timestamptz;

-- Existing counts start their idle window at migration time.
UPDATE users SET last_failed_login_at = now() WHERE failed_logins > 0;

-- +goose Down
ALTER TABLE users
    DROP COLUMN last_failed_login_at,
    DROP COLUMN totp_locked_until,
    DROP COLUMN totp_failed_logins;
