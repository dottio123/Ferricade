-- +goose Up
-- One row per admin: the dashboard layout and look. prefs holds the API shape
-- ({preset, modules, pinned_device_ids, theme, density}); reads normalise it, so
-- the catalog can change without a migration.
CREATE TABLE user_preferences (
    user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    prefs      jsonb NOT NULL,
    updated_at timestamptz NOT NULL
);

-- +goose StatementBegin
CREATE FUNCTION user_preferences_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'prefs',
        'user_id', NEW.user_id
    )::text);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER user_preferences_notify
    AFTER INSERT OR UPDATE ON user_preferences
    FOR EACH ROW EXECUTE FUNCTION user_preferences_notify();

-- +goose Down
DROP TABLE user_preferences;
DROP FUNCTION user_preferences_notify();
