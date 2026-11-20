-- +goose Up
CREATE TABLE client_policies (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
    settings   jsonb NOT NULL,
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX client_policies_one_default ON client_policies (is_default) WHERE is_default;
INSERT INTO client_policies (name, settings, is_default) VALUES
    ('Default', '{"approve-mode":"password-click","verification-method":"use-both-passwords"}', true);

CREATE TABLE client_policy_settings (
    id           boolean PRIMARY KEY DEFAULT true CHECK (id),
    push_enabled boolean NOT NULL DEFAULT false,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO client_policy_settings DEFAULT VALUES;

ALTER TABLE device_groups ADD COLUMN policy_id uuid REFERENCES client_policies(id);
ALTER TABLE devices ADD COLUMN strategy_version_seen bigint;

CREATE TABLE access_windows (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id           uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    opened_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    opened_at           timestamptz NOT NULL DEFAULT now(),
    ends_at             timestamptz,
    closed_at           timestamptz,
    closed_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    close_reason        text CHECK (close_reason IN ('manual', 'expired')),
    disconnect_on_close boolean NOT NULL DEFAULT false,
    CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
CREATE UNIQUE INDEX access_windows_one_open ON access_windows (device_id) WHERE closed_at IS NULL;

ALTER TABLE device_alerts DROP CONSTRAINT device_alerts_kind_check,
    ADD CONSTRAINT device_alerts_kind_check CHECK (kind IN ('uuid_mismatch', 'access_window_unconfirmed'));

DROP TRIGGER devices_notify_updated ON devices;
CREATE TRIGGER devices_notify_updated
    AFTER UPDATE ON devices
    FOR EACH ROW WHEN (
        OLD.hostname IS DISTINCT FROM NEW.hostname
        OR OLD.os IS DISTINCT FROM NEW.os
        OR OLD.client_version IS DISTINCT FROM NEW.client_version
        OR OLD.username IS DISTINCT FROM NEW.username
        OR OLD.strategy_version_seen IS DISTINCT FROM NEW.strategy_version_seen)
    EXECUTE FUNCTION devices_notify_updated();

-- +goose StatementBegin
CREATE FUNCTION access_windows_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'device', 'op', 'updated', 'device_id', NEW.device_id
    )::text);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER access_windows_notify
    AFTER INSERT OR UPDATE ON access_windows
    FOR EACH ROW EXECUTE FUNCTION access_windows_notify();

-- +goose Down
DROP TRIGGER access_windows_notify ON access_windows;
DROP FUNCTION access_windows_notify();
DROP TRIGGER devices_notify_updated ON devices;
CREATE TRIGGER devices_notify_updated
    AFTER UPDATE ON devices
    FOR EACH ROW WHEN (
        OLD.hostname IS DISTINCT FROM NEW.hostname
        OR OLD.os IS DISTINCT FROM NEW.os
        OR OLD.client_version IS DISTINCT FROM NEW.client_version
        OR OLD.username IS DISTINCT FROM NEW.username)
    EXECUTE FUNCTION devices_notify_updated();
ALTER TABLE device_alerts DROP CONSTRAINT device_alerts_kind_check,
    ADD CONSTRAINT device_alerts_kind_check CHECK (kind IN ('uuid_mismatch'));
DROP TABLE access_windows;
ALTER TABLE devices DROP COLUMN strategy_version_seen;
ALTER TABLE device_groups DROP COLUMN policy_id;
DROP TABLE client_policy_settings;
DROP TABLE client_policies;
