-- +goose Up
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'admin', 'user'));

CREATE TABLE user_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id uuid REFERENCES device_groups(id) ON DELETE CASCADE,
    device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT user_grants_one_target CHECK (num_nonnulls(group_id, device_id) = 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX user_grants_user_group_key ON user_grants(user_id, group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX user_grants_user_device_key ON user_grants(user_id, device_id) WHERE device_id IS NOT NULL;

-- +goose StatementBegin
CREATE FUNCTION visible_groups(uid uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE tree(id) AS (
        SELECT group_id FROM user_grants WHERE user_id = uid AND group_id IS NOT NULL
        UNION
        SELECT g.id FROM device_groups g JOIN tree ON g.parent_id = tree.id
    )
    SELECT id FROM tree;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION visible_devices(uid uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
    SELECT d.id FROM devices d
    WHERE d.state = 'approved' AND (
        EXISTS (SELECT 1 FROM user_grants ug WHERE ug.user_id = uid AND ug.device_id = d.id)
        OR d.group_id IN (SELECT visible_groups(uid))
    );
$$;
-- +goose StatementEnd

-- +goose StatementBegin
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
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION user_grants_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'grants', 'user_id', COALESCE(NEW.user_id, OLD.user_id))::text);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER user_grants_notify AFTER INSERT OR DELETE ON user_grants
    FOR EACH ROW EXECUTE FUNCTION user_grants_notify();

-- +goose Down
DROP TRIGGER user_grants_notify ON user_grants;
DROP FUNCTION user_grants_notify();
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION audit_events_notify() RETURNS trigger
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
DROP FUNCTION visible_devices(uuid);
DROP FUNCTION visible_groups(uuid);
DROP TABLE user_grants;
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'admin'));
