-- Phase 1b: announce on rdadmin_events the changes the admin console shows
-- live that no audit entry covers: a session's authentication (it brings the
-- peer and the type) and a device's sysinfo details.

-- +goose Up
-- NOTIFY is delivered on commit only, so listeners never see a rolled-back
-- change.
-- +goose StatementBegin
CREATE FUNCTION remote_sessions_notify_updated() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'session',
        'op', 'updated',
        'session_id', NEW.id,
        'device_id', NEW.device_id
    )::text);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

-- Only the first auth record: a later one changes nothing the console lists.
CREATE TRIGGER remote_sessions_notify_updated
    AFTER UPDATE OF authed_at ON remote_sessions
    FOR EACH ROW WHEN (OLD.authed_at IS NULL AND NEW.authed_at IS NOT NULL)
    EXECUTE FUNCTION remote_sessions_notify_updated();

-- +goose StatementBegin
CREATE FUNCTION devices_notify_updated() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'device',
        'op', 'updated',
        'device_id', NEW.id
    )::text);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

-- The sysinfo fields the console shows. Admin changes to a device are
-- announced through their audit entries, and heartbeat times (last_seen_at)
-- through the online tracker, so neither fires this.
CREATE TRIGGER devices_notify_updated
    AFTER UPDATE ON devices
    FOR EACH ROW WHEN (
        OLD.hostname IS DISTINCT FROM NEW.hostname
        OR OLD.os IS DISTINCT FROM NEW.os
        OR OLD.client_version IS DISTINCT FROM NEW.client_version
        OR OLD.username IS DISTINCT FROM NEW.username)
    EXECUTE FUNCTION devices_notify_updated();

-- +goose Down
DROP TRIGGER devices_notify_updated ON devices;
DROP FUNCTION devices_notify_updated();
DROP TRIGGER remote_sessions_notify_updated ON remote_sessions;
DROP FUNCTION remote_sessions_notify_updated();
