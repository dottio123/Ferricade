-- Session Kill: an admin asks for an open remote session to be disconnected.
-- The request is stored on the session; the device's next heartbeat reply
-- lists the connection id, and the session then ends as 'disconnected'.

-- +goose Up
ALTER TABLE remote_sessions
    ADD COLUMN disconnect_requested_at timestamptz,
    ADD COLUMN disconnect_requested_by uuid REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE remote_sessions DROP CONSTRAINT remote_sessions_end_reason_check;
ALTER TABLE remote_sessions ADD CONSTRAINT remote_sessions_end_reason_check
    CHECK (end_reason IN ('closed', 'stale', 'disconnected'));

-- The request is announced like the first auth record (migration 00006), so
-- the console shows it live; a repeat request changes nothing.
DROP TRIGGER remote_sessions_notify_updated ON remote_sessions;
CREATE TRIGGER remote_sessions_notify_updated
    AFTER UPDATE OF authed_at, disconnect_requested_at ON remote_sessions
    FOR EACH ROW WHEN (
        (OLD.authed_at IS NULL AND NEW.authed_at IS NOT NULL)
        OR (OLD.disconnect_requested_at IS NULL AND NEW.disconnect_requested_at IS NOT NULL))
    EXECUTE FUNCTION remote_sessions_notify_updated();

-- +goose Down
DROP TRIGGER remote_sessions_notify_updated ON remote_sessions;
CREATE TRIGGER remote_sessions_notify_updated
    AFTER UPDATE OF authed_at ON remote_sessions
    FOR EACH ROW WHEN (OLD.authed_at IS NULL AND NEW.authed_at IS NOT NULL)
    EXECUTE FUNCTION remote_sessions_notify_updated();

-- Sessions that ended as 'disconnected' end as 'closed' again.
UPDATE remote_sessions SET end_reason = 'closed' WHERE end_reason = 'disconnected';
ALTER TABLE remote_sessions DROP CONSTRAINT remote_sessions_end_reason_check;
ALTER TABLE remote_sessions ADD CONSTRAINT remote_sessions_end_reason_check
    CHECK (end_reason IN ('closed', 'stale'));
ALTER TABLE remote_sessions
    DROP COLUMN disconnect_requested_by,
    DROP COLUMN disconnect_requested_at;
