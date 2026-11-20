-- +goose Up
CREATE TABLE group_rules (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id   uuid NOT NULL REFERENCES device_groups (id) ON DELETE CASCADE,
    pattern    text NOT NULL CHECK (pattern ~ '^[A-Za-z0-9._*?-]{1,128}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX group_rules_group_pattern_key ON group_rules (group_id, lower(pattern));
CREATE INDEX group_rules_group_id_idx ON group_rules (group_id);
ALTER TABLE device_alerts DROP CONSTRAINT device_alerts_kind_check,
    ADD CONSTRAINT device_alerts_kind_check CHECK (kind IN ('uuid_mismatch', 'access_window_unconfirmed', 'group_conflict'));

-- +goose Down
DELETE FROM device_alerts WHERE kind = 'group_conflict';
ALTER TABLE device_alerts DROP CONSTRAINT device_alerts_kind_check,
    ADD CONSTRAINT device_alerts_kind_check CHECK (kind IN ('uuid_mismatch', 'access_window_unconfirmed'));
DROP TABLE group_rules;
