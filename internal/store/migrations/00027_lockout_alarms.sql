-- +goose Up
ALTER TABLE id_blocked_alarm_windows
    ADD COLUMN reason text NOT NULL DEFAULT '' CHECK (reason IN ('', 'too_many_attempts', 'too_many_per_minute', 'ipv6_prefix')),
    ADD COLUMN ip text NOT NULL DEFAULT '',
    ADD COLUMN name text NOT NULL DEFAULT '';
ALTER TABLE id_blocked_alarm_windows DROP CONSTRAINT id_blocked_alarm_windows_pkey;
ALTER TABLE id_blocked_alarm_windows ADD PRIMARY KEY (device_id, blocked_id, reason);

-- +goose Down
DELETE FROM id_blocked_alarm_windows WHERE reason <> '';
ALTER TABLE id_blocked_alarm_windows DROP CONSTRAINT id_blocked_alarm_windows_pkey;
ALTER TABLE id_blocked_alarm_windows ADD PRIMARY KEY (device_id, blocked_id);
ALTER TABLE id_blocked_alarm_windows DROP COLUMN reason, DROP COLUMN ip, DROP COLUMN name;
