-- +goose Up
-- +goose StatementBegin
CREATE FUNCTION device_alerts_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('rdadmin_events', json_build_object(
        'kind', 'device', 'op', 'updated', 'device_id', NEW.device_id
    )::text);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER device_alerts_notify
    AFTER INSERT OR UPDATE ON device_alerts
    FOR EACH ROW EXECUTE FUNCTION device_alerts_notify();

-- +goose Down
DROP TRIGGER device_alerts_notify ON device_alerts;
DROP FUNCTION device_alerts_notify();
