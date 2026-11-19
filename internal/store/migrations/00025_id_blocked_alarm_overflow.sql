-- +goose Up
CREATE TABLE id_blocked_alarm_overflow (
    device_id uuid PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
    first_seen timestamptz NOT NULL,
    last_seen timestamptz NOT NULL,
    alarm_count integer NOT NULL CHECK (alarm_count > 0)
);

-- +goose Down
DROP TABLE id_blocked_alarm_overflow;
