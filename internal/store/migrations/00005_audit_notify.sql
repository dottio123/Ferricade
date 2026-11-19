-- Phase 1b: announce every new audit entry on rdadmin_events, like the
-- session and preference triggers, for the admin console's live updates.

-- +goose Up
-- NOTIFY is delivered on commit only, so a change rolled back together with
-- its audit entry is never announced.
-- +goose StatementBegin
CREATE FUNCTION audit_events_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'audit',
        'audit_id', NEW.id,
        'action', NEW.action,
        'target_type', NEW.target_type,
        'target_id', NEW.target_id
    )::text);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER audit_events_notify
    AFTER INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_notify();

-- +goose Down
DROP TRIGGER audit_events_notify ON audit_events;
DROP FUNCTION audit_events_notify();
