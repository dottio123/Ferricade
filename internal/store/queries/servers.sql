-- name: CreateServer :one
INSERT INTO servers (name, id_host, relay_host, public_key)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetServer :one
-- The single server profile (mode A).
SELECT * FROM servers ORDER BY created_at, id LIMIT 1;

-- name: UpdateServer :one
UPDATE servers SET name = $2, id_host = $3, relay_host = $4, public_key = $5, api_url = $6, links_include_server = $7, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: GetServerForUpdate :one
SELECT * FROM servers ORDER BY created_at, id LIMIT 1 FOR UPDATE;
