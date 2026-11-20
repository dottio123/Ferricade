-- +goose Up
ALTER TABLE deployment_profile
    ADD COLUMN include_id_allow_list boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE deployment_profile
    DROP COLUMN include_id_allow_list;
