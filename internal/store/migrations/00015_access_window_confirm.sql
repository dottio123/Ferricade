-- +goose Up
ALTER TABLE access_windows ADD COLUMN close_confirmed_at timestamptz;
CREATE INDEX access_windows_unconfirmed ON access_windows (device_id)
    WHERE closed_at IS NOT NULL AND close_confirmed_at IS NULL;

-- +goose Down
DROP INDEX access_windows_unconfirmed;
ALTER TABLE access_windows DROP COLUMN close_confirmed_at;
