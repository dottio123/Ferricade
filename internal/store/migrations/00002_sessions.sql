-- Phase 1b: remote session history, from the clients' POST /api/audit/conn.
-- The table is remote_sessions because sessions holds admin logins.

-- +goose Up
CREATE TABLE remote_sessions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id        uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    conn_id          integer NOT NULL,
    -- The client's u64 session_id; NULL when it sent 0.
    rd_session_id    numeric(20),
    peer_rustdesk_id text NOT NULL DEFAULT '',
    peer_name        text NOT NULL DEFAULT '',
    type             smallint, -- NULL until the auth record names it
    client_ip        inet,
    started_at       timestamptz NOT NULL,
    authed_at        timestamptz,
    ended_at         timestamptz,
    end_reason       text CHECK (end_reason IN ('closed', 'stale')),
    -- When the device last reported conn_id in a heartbeat (or the session
    -- was opened); a stale session ends at this time.
    conn_seen_at     timestamptz NOT NULL
);

-- At most one open session per (device, conn_id).
CREATE UNIQUE INDEX remote_sessions_open_conn_key ON remote_sessions (device_id, conn_id) WHERE ended_at IS NULL;
CREATE INDEX remote_sessions_started_at_id_idx ON remote_sessions (started_at DESC, id);
CREATE INDEX remote_sessions_device_id_started_at_idx ON remote_sessions (device_id, started_at DESC);

-- Nonces of audit records already applied, so a retried post has no effect.
CREATE TABLE seen_nonces (
    nonce   text PRIMARY KEY,
    seen_at timestamptz NOT NULL
);

-- NOTIFY is delivered on commit only, so listeners never see a rolled-back
-- change.
-- +goose StatementBegin
CREATE FUNCTION remote_sessions_notify() RETURNS trigger
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
-- +goose StatementEnd

CREATE TRIGGER remote_sessions_notify_started
    AFTER INSERT ON remote_sessions
    FOR EACH ROW EXECUTE FUNCTION remote_sessions_notify();

CREATE TRIGGER remote_sessions_notify_ended
    AFTER UPDATE OF ended_at ON remote_sessions
    FOR EACH ROW WHEN (OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL)
    EXECUTE FUNCTION remote_sessions_notify();

-- +goose Down
DROP TABLE seen_nonces;
DROP TABLE remote_sessions;
DROP FUNCTION remote_sessions_notify();
