-- name: ListPolicies :many
SELECT * FROM client_policies ORDER BY is_default DESC, name, id;

-- name: ListPoliciesWithActors :many
SELECT p.id, p.name, p.settings, p.is_default, p.created_at, p.updated_at, p.updated_by,
       u.display_name AS updated_by_display_name
FROM client_policies p LEFT JOIN users u ON u.id = p.updated_by
ORDER BY p.is_default DESC, p.name, p.id;

-- name: GetPolicy :one
SELECT * FROM client_policies WHERE id = $1;

-- name: CreatePolicy :one
INSERT INTO client_policies (name, settings, updated_at, updated_by)
VALUES (sqlc.arg(name), sqlc.arg(settings), sqlc.arg(updated_at), sqlc.narg(updated_by)) RETURNING *;

-- name: UpdatePolicy :one
UPDATE client_policies SET name = sqlc.arg(name), settings = sqlc.arg(settings),
    updated_at = sqlc.arg(updated_at), updated_by = sqlc.narg(updated_by)
WHERE id = sqlc.arg(id) RETURNING *;

-- name: DeletePolicy :execrows
DELETE FROM client_policies WHERE id = $1;

-- name: CountGroupsUsingPolicy :one
SELECT count(*) FROM device_groups WHERE policy_id = $1;

-- name: GetPolicyPush :one
SELECT * FROM client_policy_settings WHERE id = true;

-- name: GetPolicyPushForUpdate :one
SELECT * FROM client_policy_settings WHERE id = true FOR UPDATE;

-- name: GetPolicyPushForShare :one
SELECT * FROM client_policy_settings WHERE id = true FOR SHARE;

-- name: HasOpenAccessWindows :one
SELECT EXISTS (SELECT 1 FROM access_windows WHERE closed_at IS NULL);

-- name: SetPolicyPush :exec
UPDATE client_policy_settings SET push_enabled = sqlc.arg(push_enabled),
    updated_at = sqlc.arg(updated_at), updated_by = sqlc.narg(updated_by)
WHERE id = true;

-- name: SetGroupPolicy :execrows
UPDATE device_groups SET policy_id = sqlc.narg(policy_id) WHERE id = sqlc.arg(id);

-- name: ListGroupEffectivePolicies :many
WITH RECURSIVE chain AS (
    SELECT g.id AS group_id, g.id AS ancestor_id, g.parent_id, g.policy_id, 0 AS depth
    FROM device_groups g
    UNION ALL
    SELECT c.group_id, p.id, p.parent_id, p.policy_id, c.depth + 1
    FROM chain c JOIN device_groups p ON p.id = c.parent_id
), nearest AS (
    SELECT DISTINCT ON (group_id) group_id, policy_id
    FROM chain WHERE policy_id IS NOT NULL
    ORDER BY group_id, depth
)
SELECT g.id AS group_id, coalesce(n.policy_id, d.id) AS effective_policy_id
FROM device_groups g CROSS JOIN client_policies d
LEFT JOIN nearest n ON n.group_id = g.id
WHERE d.is_default = true;

-- name: ResolveDevicePolicy :one
WITH RECURSIVE starting AS (
    SELECT group_id FROM devices WHERE id = sqlc.arg(device_id)::uuid
), chain AS (
    SELECT g.id, g.parent_id, g.name, g.policy_id, 0 AS depth
    FROM device_groups g JOIN starting s ON g.id = s.group_id
    UNION ALL
    SELECT g.id, g.parent_id, g.name, g.policy_id, chain.depth + 1
    FROM device_groups g JOIN chain ON g.id = chain.parent_id
), chosen AS (
    SELECT id, name, policy_id, depth FROM chain
    WHERE policy_id IS NOT NULL ORDER BY depth LIMIT 1
)
SELECT p.id, p.name, p.settings, p.is_default, p.created_at, p.updated_at, p.updated_by,
    CASE WHEN chosen.id IS NULL THEN 'default'
         WHEN chosen.depth = 0 THEN 'group' ELSE 'parent_group' END::text AS source,
    chosen.id AS source_group_id, chosen.name AS source_group_name
FROM starting CROSS JOIN client_policies fallback
LEFT JOIN chosen ON true
JOIN client_policies p ON p.id = coalesce(chosen.policy_id, fallback.id)
WHERE fallback.is_default = true;

-- name: ResolveGroupPolicy :one
WITH RECURSIVE starting AS (
    SELECT id, parent_id, name, policy_id FROM device_groups WHERE id = sqlc.arg(group_id)::uuid
), chain AS (
    SELECT id, parent_id, name, policy_id, 0 AS depth FROM starting
    UNION ALL
    SELECT g.id, g.parent_id, g.name, g.policy_id, chain.depth + 1
    FROM device_groups g JOIN chain ON g.id = chain.parent_id
), chosen AS (
    SELECT id, name, policy_id, depth FROM chain
    WHERE policy_id IS NOT NULL ORDER BY depth LIMIT 1
)
SELECT p.id, p.name, p.settings, p.is_default, p.created_at, p.updated_at, p.updated_by,
    CASE WHEN chosen.id IS NULL THEN 'default'
         WHEN chosen.depth = 0 THEN 'group' ELSE 'parent_group' END::text AS source,
    chosen.id AS source_group_id, chosen.name AS source_group_name
FROM starting CROSS JOIN client_policies fallback
LEFT JOIN chosen ON true
JOIN client_policies p ON p.id = coalesce(chosen.policy_id, fallback.id)
WHERE fallback.is_default = true;

-- name: GetDeviceStrategyInputs :one
WITH RECURSIVE target AS (
    SELECT id, state, uuid, group_id, strategy_version_seen
    FROM devices
    WHERE server_id = sqlc.arg(server_id)::uuid AND rustdesk_id = sqlc.arg(rustdesk_id)::text
), chain AS (
    SELECT g.id, g.parent_id, g.policy_id, 0 AS depth
    FROM device_groups g JOIN target d ON g.id = d.group_id
    UNION ALL
    SELECT g.id, g.parent_id, g.policy_id, chain.depth + 1
    FROM device_groups g JOIN chain ON g.id = chain.parent_id
), chosen AS (
    SELECT policy_id FROM chain WHERE policy_id IS NOT NULL ORDER BY depth LIMIT 1
)
SELECT d.id, d.state, d.uuid, d.strategy_version_seen, push.push_enabled,
       p.settings, w.id AS window_id, w.ends_at,
       EXISTS (SELECT 1 FROM access_windows closed
               WHERE closed.device_id = d.id AND closed.closed_at IS NOT NULL
                 AND closed.close_confirmed_at IS NULL)::boolean AS unconfirmed_close
FROM target d
CROSS JOIN client_policy_settings push
CROSS JOIN client_policies fallback
LEFT JOIN chosen ON true
JOIN client_policies p ON p.id = coalesce(chosen.policy_id, fallback.id)
LEFT JOIN access_windows w ON w.device_id = d.id AND w.closed_at IS NULL
WHERE push.id = true AND fallback.is_default = true;

-- name: GetDeviceStrategyInputsByID :one
WITH RECURSIVE target AS (
    SELECT id, state, uuid, group_id, id_allow_list, strategy_version_seen
    FROM devices WHERE id = sqlc.arg(device_id)::uuid
), chain AS (
    SELECT g.id, g.parent_id, g.name, g.id_allow_list, g.policy_id, 0 AS depth
    FROM device_groups g JOIN target d ON g.id = d.group_id
    UNION ALL
    SELECT p.id, p.parent_id, p.name, p.id_allow_list, p.policy_id, child.depth + 1
    FROM device_groups p JOIN chain child ON p.id = child.parent_id
), chosen AS (
    SELECT policy_id FROM chain WHERE policy_id IS NOT NULL ORDER BY depth LIMIT 1
), allow_entries AS (
    SELECT value::text AS id, 'global'::text AS source, NULL::uuid AS group_id,
           NULL::text AS group_name, 0 AS source_order, 0 AS depth, ordinal::int AS ordinal
    FROM global_id_allow_list g CROSS JOIN LATERAL unnest(g.ids) WITH ORDINALITY AS x(value, ordinal)
    WHERE g.id = true
    UNION ALL
    SELECT value::text, 'group', g.id, g.name, 1, g.depth, ordinal::int
    FROM chain g CROSS JOIN LATERAL unnest(g.id_allow_list) WITH ORDINALITY AS x(value, ordinal)
    UNION ALL
    SELECT value::text, 'device', NULL::uuid, NULL::text, 2, 0, ordinal::int
    FROM target d CROSS JOIN LATERAL unnest(d.id_allow_list) WITH ORDINALITY AS x(value, ordinal)
), deduped_allow_entries AS (
    SELECT DISTINCT ON (lower(id), source) id, source, group_id, group_name, source_order, depth, ordinal
    FROM allow_entries
    ORDER BY lower(id), source, depth, ordinal
), allow_list AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'ID', id, 'Source', source, 'GroupID', group_id, 'GroupName', group_name,
        'SourceOrder', source_order, 'Depth', depth, 'Ordinal', ordinal
    ) ORDER BY lower(id), source, depth, ordinal), '[]'::jsonb) AS entries
    FROM deduped_allow_entries
)
SELECT d.id, d.state, d.uuid, d.strategy_version_seen, push.push_enabled,
       p.settings, w.id AS window_id, w.ends_at,
       EXISTS (SELECT 1 FROM access_windows closed
               WHERE closed.device_id = d.id AND closed.closed_at IS NOT NULL
                 AND closed.close_confirmed_at IS NULL)::boolean AS unconfirmed_close,
       allow_list.entries AS allow_list
FROM target d
CROSS JOIN client_policy_settings push
CROSS JOIN client_policies fallback
CROSS JOIN allow_list
LEFT JOIN chosen ON true
JOIN client_policies p ON p.id = coalesce(chosen.policy_id, fallback.id)
LEFT JOIN access_windows w ON w.device_id = d.id AND w.closed_at IS NULL
WHERE push.id = true AND fallback.is_default = true;

-- name: SetStrategyVersionSeen :exec
UPDATE devices SET strategy_version_seen = sqlc.arg(reported)::bigint
WHERE id = sqlc.arg(id)::uuid
  AND strategy_version_seen IS DISTINCT FROM sqlc.arg(reported)::bigint;

-- name: ConfirmAccessWindowCloses :exec
UPDATE access_windows SET close_confirmed_at = sqlc.arg(now)
WHERE device_id = sqlc.arg(device_id) AND closed_at IS NOT NULL AND close_confirmed_at IS NULL;

-- name: GetWindowDeviceForUpdate :one
SELECT id, state, strategy_version_seen FROM devices WHERE id = $1 FOR UPDATE;

-- name: GetWindowDevice :one
SELECT d.id, d.strategy_version_seen, p.push_enabled, d.state
FROM devices d CROSS JOIN client_policy_settings p WHERE d.id = $1 AND p.id = true;

-- name: GetOpenAccessWindow :one
SELECT * FROM access_windows WHERE device_id = $1 AND closed_at IS NULL;

-- name: GetOpenAccessWindowForUpdate :one
SELECT * FROM access_windows WHERE device_id = $1 AND closed_at IS NULL FOR UPDATE;

-- name: GetLatestUnconfirmedClose :one
SELECT closed_at FROM access_windows
WHERE device_id = $1 AND closed_at IS NOT NULL AND close_confirmed_at IS NULL
ORDER BY closed_at DESC, id DESC LIMIT 1;

-- name: OpenAccessWindow :one
INSERT INTO access_windows (device_id, opened_by, opened_at, ends_at, disconnect_on_close)
VALUES (sqlc.arg(device_id), sqlc.arg(opened_by), sqlc.arg(opened_at), sqlc.narg(ends_at), sqlc.arg(disconnect_on_close)) RETURNING *;

-- name: CloseAccessWindow :exec
UPDATE access_windows SET closed_at = sqlc.arg(closed_at), closed_by = sqlc.narg(closed_by), close_reason = sqlc.arg(reason)
WHERE id = sqlc.arg(id) AND closed_at IS NULL;

-- name: ListExpiredAccessWindows :many
SELECT * FROM access_windows WHERE closed_at IS NULL AND ends_at <= sqlc.arg(now)::timestamptz
ORDER BY ends_at, id;

-- name: ListUnconfirmedAccessWindowAlerts :many
SELECT w.id, w.device_id, w.closed_at FROM access_windows w
WHERE w.closed_at IS NOT NULL AND w.close_confirmed_at IS NULL
  AND w.closed_at <= sqlc.arg(now)::timestamptz - interval '5 minutes'
  AND NOT EXISTS (
    SELECT 1 FROM device_alerts a WHERE a.kind = 'access_window_unconfirmed'
      AND a.device_id = w.device_id AND a.details->>'window_id' = w.id::text
  );

-- name: RequestDeviceSessionsDisconnect :execrows
UPDATE remote_sessions SET disconnect_requested_at = sqlc.arg(now), disconnect_requested_by = sqlc.narg(requested_by)
WHERE device_id = sqlc.arg(device_id) AND ended_at IS NULL AND disconnect_requested_at IS NULL;

-- name: OpenAccessWindowAlert :exec
WITH candidate AS (
  SELECT w.id, w.device_id FROM access_windows w
  WHERE w.id = sqlc.arg(window_id)::uuid AND w.device_id = sqlc.arg(device_id)::uuid
    AND w.closed_at IS NOT NULL AND w.close_confirmed_at IS NULL
    AND w.closed_at <= sqlc.arg(now)::timestamptz - interval '5 minutes'
  FOR UPDATE
)
INSERT INTO device_alerts (device_id, kind, details)
SELECT c.device_id, 'access_window_unconfirmed', sqlc.arg(details)::jsonb FROM candidate c
WHERE NOT EXISTS (
  SELECT 1 FROM device_alerts a WHERE a.device_id = c.device_id
    AND a.kind = 'access_window_unconfirmed' AND a.details->>'window_id' = c.id::text
)
ON CONFLICT (device_id, kind) WHERE resolved_at IS NULL DO NOTHING;

-- name: ResolveConfirmedAccessWindowAlerts :exec
UPDATE device_alerts a SET resolved_at = sqlc.arg(now), resolved_by = NULL
WHERE a.kind = 'access_window_unconfirmed' AND a.resolved_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM access_windows w WHERE w.id::text = a.details->>'window_id'
      AND w.close_confirmed_at IS NULL
  );

-- name: SummaryOpenPolicyAlerts :many
SELECT a.kind, a.created_at, d.id AS device_id, d.rustdesk_id, d.alias, d.hostname,
       COALESCE((SELECT string_agg(g.name, ', ' ORDER BY g.name COLLATE "C", g.id)
                 FROM device_groups g
                 WHERE g.id::text IN (SELECT jsonb_array_elements_text(a.details->'group_ids'))
                   AND (sqlc.narg('scope_user')::uuid IS NULL OR g.id IN (SELECT visible_groups(sqlc.narg('scope_user')::uuid)))), '')::text AS group_names
FROM device_alerts a JOIN devices d ON d.id = a.device_id
WHERE a.resolved_at IS NULL AND a.kind IN ('uuid_mismatch', 'access_window_unconfirmed', 'group_conflict')
  AND (a.kind <> 'group_conflict' OR d.state = 'approved')
  AND (sqlc.narg('scope_user')::uuid IS NULL OR d.id IN (SELECT visible_devices(sqlc.narg('scope_user')::uuid)));
