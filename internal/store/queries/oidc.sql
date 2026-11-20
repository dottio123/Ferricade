-- name: GetOIDCSettings :one
SELECT * FROM oidc_settings WHERE id = true;

-- name: GetOIDCSettingsForUpdate :one
SELECT * FROM oidc_settings WHERE id = true FOR UPDATE;

-- name: UpdateOIDCSettings :one
UPDATE oidc_settings SET enabled = sqlc.arg(enabled), display_name = sqlc.arg(display_name),
    issuer = sqlc.arg(issuer), client_id = sqlc.arg(client_id),
    client_secret_enc = sqlc.arg(client_secret_enc), groups_claim = sqlc.arg(groups_claim),
    owner_groups = sqlc.arg(owner_groups), admin_groups = sqlc.arg(admin_groups),
    user_groups = sqlc.arg(user_groups),
    jit_enabled = sqlc.arg(jit_enabled), updated_at = now(), updated_by = sqlc.arg(updated_by)
WHERE id = true RETURNING *;

-- name: SetOIDCTestResult :exec
UPDATE oidc_settings SET last_test_at = sqlc.arg(last_test_at), last_test_result = sqlc.arg(last_test_result)
WHERE id = true;
