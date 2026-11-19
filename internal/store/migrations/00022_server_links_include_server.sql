-- +goose Up
ALTER TABLE servers ADD COLUMN links_include_server boolean NOT NULL DEFAULT true;

-- +goose Down
ALTER TABLE servers DROP COLUMN links_include_server;
