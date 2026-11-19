-- +goose Up
ALTER TABLE oidc_settings ADD COLUMN user_groups text[] NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE oidc_settings DROP COLUMN user_groups;
