-- +goose Up
DROP INDEX audit_events_at_id_idx;
CREATE INDEX audit_events_at_id_idx ON audit_events (at DESC, id DESC);
CREATE INDEX audit_events_action_at_id_idx ON audit_events (action, at DESC, id DESC);
DROP INDEX remote_sessions_started_at_id_idx;
CREATE INDEX remote_sessions_started_at_id_idx ON remote_sessions (started_at DESC, id DESC);

-- +goose Down
DROP INDEX remote_sessions_started_at_id_idx;
CREATE INDEX remote_sessions_started_at_id_idx ON remote_sessions (started_at DESC, id);
DROP INDEX audit_events_action_at_id_idx;
DROP INDEX audit_events_at_id_idx;
CREATE INDEX audit_events_at_id_idx ON audit_events (at DESC, id);
