-- Phase 1a schema. See docs/superpowers/specs/2026-10-06-phase-1a-backend-design.md, "Data model".

-- +goose Up
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username        citext NOT NULL UNIQUE,
    display_name    text NOT NULL DEFAULT '',
    email           text NOT NULL DEFAULT '',
    role            text NOT NULL CHECK (role IN ('owner', 'admin')),
    password_hash   text NOT NULL,
    totp_secret_enc bytea,
    totp_required   boolean NOT NULL DEFAULT false,
    -- Highest TOTP time step accepted so far; a code is only valid for a
    -- greater step, so a code cannot be replayed within its window.
    totp_last_step  bigint NOT NULL DEFAULT 0,
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    failed_logins   integer NOT NULL DEFAULT 0,
    locked_until    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id           bytea PRIMARY KEY, -- SHA-256 of the cookie token
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    csrf_token   text NOT NULL,
    mfa_passed   boolean NOT NULL DEFAULT false,
    ip           inet NOT NULL,
    user_agent   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE servers (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    id_host    text NOT NULL,
    relay_host text NOT NULL DEFAULT '',
    public_key text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_groups (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id uuid REFERENCES device_groups (id),
    name      text NOT NULL,
    CONSTRAINT device_groups_parent_id_name_key UNIQUE NULLS NOT DISTINCT (parent_id, name)
);

CREATE TABLE devices (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id      uuid NOT NULL REFERENCES servers (id),
    rustdesk_id    text NOT NULL,
    uuid           text NOT NULL, -- the client's base64 uuid, pinned at enrollment
    state          text NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'approved', 'rejected', 'archived')),
    alias          text NOT NULL DEFAULT '',
    hostname       text NOT NULL DEFAULT '',
    os             text NOT NULL DEFAULT '',
    cpu            text NOT NULL DEFAULT '',
    memory         text NOT NULL DEFAULT '',
    client_version text NOT NULL DEFAULT '',
    username       text NOT NULL DEFAULT '',
    note           text NOT NULL DEFAULT '',
    group_id       uuid REFERENCES device_groups (id),
    -- NULL until the first sysinfo is stored (then at least '{}'), so it
    -- also tells the heartbeat whether to ask for sysinfo.
    presets        jsonb,
    first_seen_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    approved_by    uuid REFERENCES users (id),
    approved_at    timestamptz,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT devices_server_id_rustdesk_id_key UNIQUE (server_id, rustdesk_id)
);

CREATE INDEX devices_server_id_state_idx ON devices (server_id, state);
CREATE INDEX devices_group_id_idx ON devices (group_id);

CREATE TABLE device_alerts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('uuid_mismatch')),
    details     jsonb NOT NULL DEFAULT '{}', -- {seen_uuid, ip}
    created_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    resolved_by uuid REFERENCES users (id)
);

-- At most one unresolved alert per (device, kind).
CREATE UNIQUE INDEX device_alerts_open_key ON device_alerts (device_id, kind) WHERE resolved_at IS NULL;

CREATE TABLE tags (
    id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name  citext NOT NULL UNIQUE,
    color bigint NOT NULL DEFAULT 0 -- ARGB, unsigned 32-bit (e.g. 0xFF1E88E5)
);

CREATE TABLE device_tags (
    device_id uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    tag_id    uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (device_id, tag_id)
);

CREATE INDEX device_tags_tag_id_idx ON device_tags (tag_id);

CREATE TABLE audit_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    at            timestamptz NOT NULL DEFAULT now(),
    actor_user_id uuid REFERENCES users (id),
    actor_ip      inet NOT NULL,
    action        text NOT NULL,
    target_type   text NOT NULL DEFAULT '',
    target_id     text NOT NULL DEFAULT '',
    details       jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_events_at_id_idx ON audit_events (at DESC, id);

-- audit_events is append-only. Migrations run as the application role, which
-- therefore owns the table and keeps UPDATE and DELETE whatever is revoked;
-- the triggers below are what enforce it. Other roles lose the privileges.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION audit_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER audit_events_no_update_delete
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- Row triggers do not fire for TRUNCATE.
CREATE TRIGGER audit_events_no_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

CREATE TABLE settings (
    key   text PRIMARY KEY,
    value jsonb NOT NULL
);

-- +goose Down
DROP TABLE settings;
DROP TABLE audit_events;
DROP FUNCTION audit_events_immutable();
DROP TABLE device_tags;
DROP TABLE tags;
DROP TABLE device_alerts;
DROP TABLE devices;
DROP TABLE device_groups;
DROP TABLE servers;
DROP TABLE sessions;
DROP TABLE users;
