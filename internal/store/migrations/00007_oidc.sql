-- +goose Up
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN oidc_issuer text, ADD COLUMN oidc_subject text,
    ADD COLUMN avatar bytea, ADD COLUMN avatar_type text,
    ADD COLUMN avatar_updated_at timestamptz,
    ADD CONSTRAINT users_oidc_pair CHECK ((oidc_issuer IS NULL) = (oidc_subject IS NULL));
CREATE UNIQUE INDEX users_oidc_identity_idx ON users (oidc_issuer, oidc_subject) WHERE oidc_issuer IS NOT NULL;

CREATE TABLE oidc_settings (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    enabled boolean NOT NULL DEFAULT false,
    display_name text NOT NULL DEFAULT '',
    issuer text NOT NULL DEFAULT '',
    client_id text NOT NULL DEFAULT '',
    client_secret_enc bytea,
    groups_claim text NOT NULL DEFAULT 'groups',
    owner_groups text[] NOT NULL DEFAULT '{}',
    admin_groups text[] NOT NULL DEFAULT '{}',
    jit_enabled boolean NOT NULL DEFAULT false,
    last_test_at timestamptz,
    last_test_result jsonb,
    updated_at timestamptz,
    updated_by uuid REFERENCES users (id) ON DELETE SET NULL
);
INSERT INTO oidc_settings (id) VALUES (true);

-- +goose Down
DROP TABLE oidc_settings;
DROP INDEX users_oidc_identity_idx;
ALTER TABLE users DROP CONSTRAINT users_oidc_pair,
    DROP COLUMN oidc_issuer, DROP COLUMN oidc_subject,
    DROP COLUMN avatar, DROP COLUMN avatar_type, DROP COLUMN avatar_updated_at;
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
