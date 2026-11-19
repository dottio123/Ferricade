-- +goose Up
CREATE TABLE session_settings (
    id         boolean PRIMARY KEY DEFAULT true CHECK (id),
    lifetime   text NOT NULL DEFAULT 'browser' CHECK (lifetime IN ('browser', '8h', '1d', '7d', '30d')),
    updated_at timestamptz,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO session_settings DEFAULT VALUES;

ALTER TABLE sessions ADD COLUMN persistent boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE sessions DROP COLUMN persistent;
DROP TABLE session_settings;
