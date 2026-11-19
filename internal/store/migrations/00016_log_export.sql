-- +goose Up
CREATE TABLE log_export_settings (
    id              boolean PRIMARY KEY DEFAULT true CHECK (id),
    file_enabled    boolean NOT NULL DEFAULT false,
    syslog_enabled  boolean NOT NULL DEFAULT false,
    syslog_host     text    NOT NULL DEFAULT '',
    syslog_port     integer NOT NULL DEFAULT 6514 CHECK (syslog_port BETWEEN 1 AND 65535),
    syslog_tls      boolean NOT NULL DEFAULT true,
    syslog_ca_pem   text    NOT NULL DEFAULT '',
    syslog_facility text    NOT NULL DEFAULT 'local0',
    syslog_format   text    NOT NULL DEFAULT 'json' CHECK (syslog_format IN ('json', 'text')),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid REFERENCES users (id) ON DELETE SET NULL
);
INSERT INTO log_export_settings DEFAULT VALUES;

CREATE TABLE log_export_outbox (
    id             bigserial PRIMARY KEY,
    source         text NOT NULL CHECK (source IN ('audit', 'session')),
    ref_id         uuid NOT NULL,
    phase          text CHECK (phase IN ('start', 'end')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    file_done_at   timestamptz,
    syslog_done_at timestamptz,
    CHECK ((source = 'audit') = (phase IS NULL))
);
CREATE INDEX log_export_outbox_file_pending_idx ON log_export_outbox (id) WHERE file_done_at IS NULL;
CREATE INDEX log_export_outbox_syslog_pending_idx ON log_export_outbox (id) WHERE syslog_done_at IS NULL;
CREATE INDEX log_export_outbox_created_at_idx ON log_export_outbox (created_at);

-- +goose StatementBegin
CREATE FUNCTION log_export_audit_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO log_export_outbox (source, ref_id) VALUES ('audit', NEW.id);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER log_export_audit_enqueue AFTER INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION log_export_audit_enqueue();

-- +goose StatementBegin
CREATE FUNCTION log_export_session_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO log_export_outbox (source, ref_id, phase) VALUES ('session', NEW.id, 'start');
        IF NEW.ended_at IS NOT NULL THEN
            INSERT INTO log_export_outbox (source, ref_id, phase) VALUES ('session', NEW.id, 'end');
        END IF;
    ELSE
        INSERT INTO log_export_outbox (source, ref_id, phase) VALUES ('session', NEW.id, 'end');
    END IF;
    RETURN NULL;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER log_export_session_started AFTER INSERT ON remote_sessions
    FOR EACH ROW EXECUTE FUNCTION log_export_session_enqueue();
CREATE TRIGGER log_export_session_ended AFTER UPDATE OF ended_at ON remote_sessions
    FOR EACH ROW WHEN (OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL)
    EXECUTE FUNCTION log_export_session_enqueue();

-- +goose Down
DROP TRIGGER log_export_session_ended ON remote_sessions;
DROP TRIGGER log_export_session_started ON remote_sessions;
DROP FUNCTION log_export_session_enqueue();
DROP TRIGGER log_export_audit_enqueue ON audit_events;
DROP FUNCTION log_export_audit_enqueue();
DROP TABLE log_export_outbox;
DROP TABLE log_export_settings;
