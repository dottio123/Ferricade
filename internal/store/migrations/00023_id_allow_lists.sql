-- +goose Up
ALTER TABLE device_groups ADD COLUMN id_allow_list text[] NOT NULL DEFAULT '{}';
ALTER TABLE devices ADD COLUMN id_allow_list text[] NOT NULL DEFAULT '{}';
CREATE TABLE global_id_allow_list (
    id  boolean PRIMARY KEY DEFAULT true CHECK (id),
    ids text[] NOT NULL DEFAULT '{}'
);
INSERT INTO global_id_allow_list DEFAULT VALUES;

-- +goose Down
DROP TABLE global_id_allow_list;
ALTER TABLE devices DROP COLUMN id_allow_list;
ALTER TABLE device_groups DROP COLUMN id_allow_list;
