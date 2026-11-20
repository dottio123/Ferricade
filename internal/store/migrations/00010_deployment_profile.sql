-- +goose Up
CREATE TABLE deployment_profile (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    installer_source text NOT NULL DEFAULT 'github',
    client_version text NOT NULL DEFAULT '1.5.0',
    url_windows text NOT NULL DEFAULT '',
    url_deb text NOT NULL DEFAULT '',
    url_rpm text NOT NULL DEFAULT '',
    sha256_windows text NOT NULL DEFAULT '',
    sha256_deb text NOT NULL DEFAULT '',
    sha256_rpm text NOT NULL DEFAULT '',
    allow_downgrade boolean NOT NULL DEFAULT false,
    include_install boolean NOT NULL DEFAULT true,
    include_password boolean NOT NULL DEFAULT false,
    include_unlock_pin boolean NOT NULL DEFAULT false,
    settings jsonb NOT NULL DEFAULT '{}',
    fleet_password_enc bytea,
    unlock_pin_enc bytea,
    password_set_at timestamptz,
    password_set_by uuid REFERENCES users(id) ON DELETE SET NULL,
    pin_set_at timestamptz,
    pin_set_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

-- +goose Down
DROP TABLE deployment_profile;
