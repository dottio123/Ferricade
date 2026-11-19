-- name: GetDeploymentProfile :one
SELECT * FROM deployment_profile WHERE id = true;

-- name: GetDeploymentProfileForUpdate :one
SELECT * FROM deployment_profile WHERE id = true FOR UPDATE;

-- name: SaveDeploymentProfile :exec
INSERT INTO deployment_profile (
    id, installer_source, client_version, url_windows, url_deb, url_rpm,
    sha256_windows, sha256_deb, sha256_rpm, allow_downgrade, include_install,
    include_password, include_unlock_pin, include_id_allow_list, settings, fleet_password_enc, unlock_pin_enc,
    password_set_at, password_set_by, pin_set_at, pin_set_by, updated_at, updated_by
) VALUES (
    true, sqlc.arg(installer_source), sqlc.arg(client_version), sqlc.arg(url_windows),
    sqlc.arg(url_deb), sqlc.arg(url_rpm), sqlc.arg(sha256_windows), sqlc.arg(sha256_deb),
    sqlc.arg(sha256_rpm), sqlc.arg(allow_downgrade), sqlc.arg(include_install),
    sqlc.arg(include_password), sqlc.arg(include_unlock_pin), sqlc.arg(include_id_allow_list), sqlc.arg(settings),
    sqlc.narg(fleet_password_enc), sqlc.narg(unlock_pin_enc), sqlc.narg(password_set_at),
    sqlc.narg(password_set_by), sqlc.narg(pin_set_at), sqlc.narg(pin_set_by),
    sqlc.arg(updated_at), sqlc.narg(updated_by)
) ON CONFLICT (id) DO UPDATE SET
    installer_source = EXCLUDED.installer_source,
    client_version = EXCLUDED.client_version,
    url_windows = EXCLUDED.url_windows, url_deb = EXCLUDED.url_deb, url_rpm = EXCLUDED.url_rpm,
    sha256_windows = EXCLUDED.sha256_windows, sha256_deb = EXCLUDED.sha256_deb,
    sha256_rpm = EXCLUDED.sha256_rpm, allow_downgrade = EXCLUDED.allow_downgrade,
    include_install = EXCLUDED.include_install, include_password = EXCLUDED.include_password,
    include_unlock_pin = EXCLUDED.include_unlock_pin, include_id_allow_list = EXCLUDED.include_id_allow_list,
    settings = EXCLUDED.settings,
    fleet_password_enc = EXCLUDED.fleet_password_enc, unlock_pin_enc = EXCLUDED.unlock_pin_enc,
    password_set_at = EXCLUDED.password_set_at, password_set_by = EXCLUDED.password_set_by,
    pin_set_at = EXCLUDED.pin_set_at, pin_set_by = EXCLUDED.pin_set_by,
    updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
