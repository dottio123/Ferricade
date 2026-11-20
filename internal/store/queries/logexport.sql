-- name: GetLogExportSettings :one
SELECT * FROM log_export_settings WHERE id = true;

-- name: LockLogExportSettings :one
SELECT * FROM log_export_settings WHERE id = true FOR UPDATE;

-- name: PutLogExportSettings :one
UPDATE log_export_settings SET file_enabled=$1, syslog_enabled=$2, syslog_host=$3,
    syslog_port=$4, syslog_tls=$5, syslog_ca_pem=$6, syslog_facility=$7,
    syslog_format=$8, updated_at=$9, updated_by=$10 WHERE id=true RETURNING *;

-- name: PendingFileLogExport :many
SELECT * FROM log_export_outbox WHERE file_done_at IS NULL ORDER BY id LIMIT 500;

-- name: PendingSyslogLogExport :many
SELECT * FROM log_export_outbox WHERE syslog_done_at IS NULL ORDER BY id LIMIT 500;

-- name: MarkFileLogExportDone :exec
UPDATE log_export_outbox SET file_done_at=$2 WHERE id=ANY($1::bigint[]) AND file_done_at IS NULL;

-- name: MarkSyslogLogExportDone :exec
UPDATE log_export_outbox SET syslog_done_at=$2 WHERE id=ANY($1::bigint[]) AND syslog_done_at IS NULL;

-- name: StartFileLogExportNow :exec
UPDATE log_export_outbox SET file_done_at=$1 WHERE file_done_at IS NULL;

-- name: StartSyslogLogExportNow :exec
UPDATE log_export_outbox SET syslog_done_at=$1 WHERE syslog_done_at IS NULL;

-- name: CountFileLogExportPending :one
SELECT count(*) FROM log_export_outbox WHERE file_done_at IS NULL;

-- name: CountSyslogLogExportPending :one
SELECT count(*) FROM log_export_outbox WHERE syslog_done_at IS NULL;

-- name: CleanupLogExport :exec
DELETE FROM log_export_outbox WHERE created_at < $1 OR
    ((NOT $2::boolean OR file_done_at IS NOT NULL) AND
     (NOT $3::boolean OR syslog_done_at IS NOT NULL));

-- name: GetLogExportAudit :one
SELECT a.id, a.at, a.actor_user_id, a.actor_ip, a.action, a.target_type, a.target_id, a.details,
    COALESCE(u.username::text, '') AS actor_name, u.role AS actor_role
FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.id=$1;

-- name: GetLogExportSession :one
SELECT s.id, s.device_id, s.type, s.peer_rustdesk_id, s.peer_name, s.client_ip,
    s.started_at, s.ended_at, s.end_reason, d.alias, d.hostname, d.rustdesk_id
FROM remote_sessions s JOIN devices d ON d.id=s.device_id WHERE s.id=$1;

-- name: GetLogExportSessions :many
SELECT s.id, s.device_id, s.type, s.peer_rustdesk_id, s.peer_name, s.client_ip,
    s.started_at, s.ended_at, s.end_reason, d.alias, d.hostname, d.rustdesk_id
FROM remote_sessions s JOIN devices d ON d.id=s.device_id WHERE s.id=ANY(sqlc.arg(ids)::uuid[]);

-- name: GetLogExportAudits :many
SELECT a.id, a.at, a.actor_user_id, a.actor_ip, a.action, a.target_type, a.target_id, a.details,
    COALESCE(actor.username::text, '') AS actor_name, actor.role AS actor_role,
    COALESCE(d.alias, '') AS target_device_alias, COALESCE(d.hostname, '') AS target_device_hostname,
    COALESCE(d.rustdesk_id, '') AS target_device_rustdesk_id,
    COALESCE(g.name, '') AS target_group_name, COALESCE(t.name, '') AS target_tag_name,
    COALESCE(target_user.username::text, '') AS target_user_name, COALESCE(p.name, '') AS target_policy_name
FROM audit_events a
LEFT JOIN users actor ON actor.id=a.actor_user_id
LEFT JOIN devices d ON a.target_type='device' AND d.id=CASE WHEN a.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN a.target_id::uuid END
LEFT JOIN device_groups g ON a.target_type='group' AND g.id=CASE WHEN a.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN a.target_id::uuid END
LEFT JOIN tags t ON a.target_type='tag' AND t.id=CASE WHEN a.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN a.target_id::uuid END
LEFT JOIN users target_user ON a.target_type='user' AND target_user.id=CASE WHEN a.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN a.target_id::uuid END
LEFT JOIN client_policies p ON a.target_type='policy' AND p.id=CASE WHEN a.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN a.target_id::uuid END
WHERE a.id=ANY(sqlc.arg(ids)::uuid[]);

-- name: GetLogExportDevice :one
SELECT alias, hostname, rustdesk_id FROM devices WHERE id=$1;

-- name: GetLogExportGroup :one
SELECT name FROM device_groups WHERE id=$1;

-- name: GetLogExportTag :one
SELECT name FROM tags WHERE id=$1;

-- name: GetLogExportUser :one
SELECT username::text FROM users WHERE id=$1;

-- name: GetLogExportPolicy :one
SELECT name FROM client_policies WHERE id=$1;
