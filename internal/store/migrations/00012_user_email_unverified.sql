-- +goose Up
ALTER TABLE users ADD COLUMN email_unverified boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE users DROP COLUMN email_unverified;
