-- name: LockDeviceForBlockedAlarm :one
SELECT id, server_id, rustdesk_id, uuid, state
FROM devices
WHERE server_id = sqlc.arg(server_id)::uuid AND rustdesk_id = sqlc.arg(rustdesk_id)::text
FOR UPDATE;

-- name: GetBlockedAlarmWindow :one
SELECT device_id, blocked_id, first_seen, last_seen, repeat_count, reason, ip, name
FROM id_blocked_alarm_windows
WHERE device_id = sqlc.arg(device_id)::uuid AND blocked_id = sqlc.arg(blocked_id)::text AND reason = sqlc.arg(reason)::text
FOR UPDATE;

-- name: InsertBlockedAlarmWindow :execrows
INSERT INTO id_blocked_alarm_windows (device_id, blocked_id, reason, ip, name, first_seen, last_seen)
VALUES (sqlc.arg(device_id)::uuid, sqlc.arg(blocked_id)::text, sqlc.arg(reason)::text, sqlc.arg(ip)::text, sqlc.arg(name)::text, sqlc.arg(now)::timestamptz, sqlc.arg(now)::timestamptz)
ON CONFLICT DO NOTHING;

-- name: IncrementBlockedAlarmWindow :execrows
UPDATE id_blocked_alarm_windows
SET repeat_count = repeat_count + 1, last_seen = sqlc.arg(now)::timestamptz
WHERE device_id = sqlc.arg(device_id)::uuid AND blocked_id = sqlc.arg(blocked_id)::text AND reason = sqlc.arg(reason)::text;

-- name: DeleteBlockedAlarmWindow :execrows
DELETE FROM id_blocked_alarm_windows
WHERE device_id = sqlc.arg(device_id)::uuid AND blocked_id = sqlc.arg(blocked_id)::text AND reason = sqlc.arg(reason)::text;

-- name: DeleteExpiredBlockedAlarmWindows :many
WITH expired AS (
    SELECT device_id, blocked_id, reason FROM id_blocked_alarm_windows
    WHERE first_seen + interval '10 minutes' <= sqlc.arg(now)::timestamptz
    FOR UPDATE SKIP LOCKED
)
DELETE FROM id_blocked_alarm_windows
WHERE (device_id, blocked_id, reason) IN (SELECT device_id, blocked_id, reason FROM expired)
RETURNING device_id, blocked_id, first_seen, last_seen, repeat_count, reason, ip, name;

-- name: CountBlockedAlarmWindows :one
SELECT count(*)::int FROM id_blocked_alarm_windows WHERE device_id = sqlc.arg(device_id)::uuid;

-- name: GetBlockedAlarmOverflow :one
SELECT device_id, first_seen, last_seen, alarm_count
FROM id_blocked_alarm_overflow
WHERE device_id = sqlc.arg(device_id)::uuid
FOR UPDATE;

-- name: InsertBlockedAlarmOverflow :execrows
INSERT INTO id_blocked_alarm_overflow (device_id, first_seen, last_seen, alarm_count)
VALUES (sqlc.arg(device_id)::uuid, sqlc.arg(now)::timestamptz, sqlc.arg(now)::timestamptz, 1)
ON CONFLICT (device_id) DO NOTHING;

-- name: IncrementBlockedAlarmOverflow :execrows
UPDATE id_blocked_alarm_overflow
SET alarm_count = alarm_count + 1, last_seen = sqlc.arg(now)::timestamptz
WHERE device_id = sqlc.arg(device_id)::uuid;

-- name: ListExpiredBlockedAlarmWindows :many
SELECT device_id, blocked_id, first_seen, last_seen, repeat_count, reason, ip, name
FROM id_blocked_alarm_windows
WHERE first_seen + interval '10 minutes' <= sqlc.arg(now)::timestamptz
FOR UPDATE SKIP LOCKED;

-- name: ListExpiredBlockedAlarmOverflow :many
SELECT device_id, first_seen, last_seen, alarm_count
FROM id_blocked_alarm_overflow
WHERE first_seen + interval '10 minutes' <= sqlc.arg(now)::timestamptz
FOR UPDATE SKIP LOCKED;

-- name: DeleteBlockedAlarmOverflow :execrows
DELETE FROM id_blocked_alarm_overflow WHERE device_id = sqlc.arg(device_id)::uuid;

-- name: DeleteExpiredBlockedAlarmOverflow :many
WITH expired AS (
    SELECT device_id FROM id_blocked_alarm_overflow
    WHERE first_seen + interval '10 minutes' <= sqlc.arg(now)::timestamptz
    FOR UPDATE SKIP LOCKED
)
DELETE FROM id_blocked_alarm_overflow WHERE device_id IN (SELECT device_id FROM expired)
RETURNING device_id, first_seen, last_seen, alarm_count;
