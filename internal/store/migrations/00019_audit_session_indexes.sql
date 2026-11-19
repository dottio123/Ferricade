-- +goose Up
CREATE INDEX audit_events_target_at_id_idx ON audit_events (target_id, at DESC, id DESC);
CREATE INDEX audit_events_actor_at_id_idx ON audit_events (actor_user_id, at DESC, id DESC);
CREATE INDEX remote_sessions_open_conn_seen_at_idx ON remote_sessions (conn_seen_at) WHERE ended_at IS NULL;

-- +goose Down
DROP INDEX remote_sessions_open_conn_seen_at_idx;
DROP INDEX audit_events_actor_at_id_idx;
DROP INDEX audit_events_target_at_id_idx;
