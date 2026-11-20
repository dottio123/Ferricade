-- +goose Up
ALTER TABLE servers ADD COLUMN api_url text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE servers DROP COLUMN api_url;
