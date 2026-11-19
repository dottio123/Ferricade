-- +goose Up
CREATE TABLE id_blocked_alarm_windows (
    device_id  uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    blocked_id text NOT NULL,
    first_seen timestamptz NOT NULL,
    last_seen  timestamptz NOT NULL,
    repeat_count integer NOT NULL DEFAULT 0 CHECK (repeat_count >= 0),
    PRIMARY KEY (device_id, blocked_id)
);

-- +goose Down
DROP TABLE id_blocked_alarm_windows;
