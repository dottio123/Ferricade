-- +goose Up
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION remote_sessions_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('ferricade_events', json_build_object(
        'kind', 'session',
        'op', CASE WHEN TG_OP = 'INSERT' THEN 'started' ELSE 'ended' END,
        'session_id', NEW.id,
        'device_id', NEW.device_id
    )::text);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION user_preferences_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('ferricade_events', json_build_object(
        'kind', 'prefs',
        'user_id', NEW.user_id
    )::text);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION audit_events_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('ferricade_events', json_build_object(
        'kind', 'audit',
        'audit_id', NEW.id,
        'action', NEW.action,
        'target_type', NEW.target_type,
        'target_id', NEW.target_id,
        'actor_user_id', NEW.actor_user_id
    )::text);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION remote_sessions_notify_updated() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('ferricade_events', json_build_object(
        'kind', 'session',
        'op', 'updated',
        'session_id', NEW.id,
        'device_id', NEW.device_id
    )::text);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION devices_notify_updated() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('ferricade_events', json_build_object(
        'kind', 'device',
        'op', 'updated',
        'device_id', NEW.id
    )::text);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION user_grants_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('ferricade_events', json_build_object(
        'kind', 'grants', 'user_id', COALESCE(NEW.user_id, OLD.user_id))::text);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION access_windows_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('ferricade_events', json_build_object(
        'kind', 'device', 'op', 'updated', 'device_id', NEW.device_id
    )::text);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION device_alerts_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('ferricade_events', json_build_object(
        'kind', 'device', 'op', 'updated', 'device_id', NEW.device_id
    )::text);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION remote_sessions_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'session',
        'op', CASE WHEN TG_OP = 'INSERT' THEN 'started' ELSE 'ended' END,
        'session_id', NEW.id,
        'device_id', NEW.device_id
    )::text);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION user_preferences_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'prefs',
        'user_id', NEW.user_id
    )::text);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION audit_events_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'audit',
        'audit_id', NEW.id,
        'action', NEW.action,
        'target_type', NEW.target_type,
        'target_id', NEW.target_id,
        'actor_user_id', NEW.actor_user_id
    )::text);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION remote_sessions_notify_updated() RETURNS trigger
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

CREATE OR REPLACE FUNCTION devices_notify_updated() RETURNS trigger
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

CREATE OR REPLACE FUNCTION user_grants_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'grants', 'user_id', COALESCE(NEW.user_id, OLD.user_id))::text);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION access_windows_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'device', 'op', 'updated', 'device_id', NEW.device_id
    )::text);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION device_alerts_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'device', 'op', 'updated', 'device_id', NEW.device_id
    )::text);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd
