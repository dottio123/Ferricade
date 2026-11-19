# Phase 1a: Backend Core — Design

Status: approved in conversation 2026-10-06, pending written review.
Parent spec: "RustDesk Admin WebUI: Implementation Plan" (Claude Docs). Phase 1b (web UI) gets its own spec and builds on the admin API defined here.

## Goal

A stock RustDesk client enrolls against our server, an admin approves it, it shows online, and the admin gets a working `rustdesk://` link for it, all through the backend and its admin API. Phase 1b adds the web UI that closes the full Phase 1 gate with a real client.

## Decisions

| Topic | Decision |
|---|---|
| Enrollment default | **Approval queue.** Unknown devices are recorded as `pending`. Only Owner and Admin see them until one of them approves |
| Listeners | **Split.** The client API is on `:21114` over plain HTTP. Admin UI and API are on `:21120`, behind an HTTPS reverse proxy |
| Web sign-in | **Password + TOTP.** Argon2id, TOTP mandatory for the owner and optional (or Owner-enforced) for others, lockout backoff, server-side sessions |
| Database | **Postgres 16 only**, with sqlc for queries and goose for migrations. SQLite is dropped from the project |
| Permissions | View-level only, inside the web app. Connections made outside it are out of scope |
| Server profiles | Exactly one attached server (mode A) in Phase 1. More arrive in Phase 3 |
| Ports | RustDesk defaults, all configurable |

## Architecture

There is one binary, `rdadmin serve`, with two HTTP listeners sharing one `pgxpool` pool.

| Listener | Env (default) | Routes | Reached by |
|---|---|---|---|
| Client | `CLIENT_LISTEN_ADDR` (`:21114`) | `POST /api/heartbeat`, `POST /api/sysinfo`, `GET /healthz`; everything else under `/api/` is 404 `{"error":"not found"}` | RustDesk clients, plain HTTP |
| Admin | `ADMIN_LISTEN_ADDR` (`:21120`) | `/admin/api/v1/*`, `/setup/*`, `GET /healthz`, plus the client routes (for clients configured with an `https://` API server through the proxy) | People, via HTTPS reverse proxy |

The admin listener refuses to start unless `PUBLIC_URL` uses https, except when `DEV_INSECURE=1`. In that mode it logs a warning at startup and every 10 minutes, and drops the `Secure` and `__Host-` cookie attributes.

### Configuration

| Env | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | `postgres://…` |
| `SECRET_KEY` | yes | — | At least 32 bytes, base64. Derives the AES-GCM key that encrypts TOTP secrets (HKDF, info `totp-v1`) |
| `PUBLIC_URL` | yes | — | The admin UI's external URL. Must be https unless `DEV_INSECURE=1` |
| `CLIENT_LISTEN_ADDR` | no | `:21114` | Replaces Phase 0's `LISTEN_ADDR` |
| `ADMIN_LISTEN_ADDR` | no | `:21120` | |
| `HBBS_ADDR` | no | empty (probe off) | Phase 0 rules: no loopback, port defaults to 21115 |
| `TRUSTED_PROXIES` | no | empty | CIDRs whose `X-Forwarded-For` / `X-Forwarded-Proto` are trusted |
| `MAX_PENDING_DEVICES` | no | `500` | |
| `DEV_INSECURE` | no | unset | `1` allows an http `PUBLIC_URL` |

Phase 0's `https://…:21114` rejection still applies to `PUBLIC_URL`.

### Packages

| Package | Responsibility |
|---|---|
| `internal/store` | goose migrations (embedded), sqlc-generated queries, `Tx(ctx, func(q *Queries) error)` helper, test helper that creates a throwaway database |
| `internal/auth` | Argon2id hashing, TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step), session create/lookup/rotate/expire, CSRF, lockout |
| `internal/setup` | First-run guard and token, owner creation, setup-complete flag |
| `internal/servers` | The single server profile; reachability check (TCP dial 21116 and 21117, optional `OnlineRequest` probe) |
| `internal/devices` | Enrollment state machine, uuid pinning and alerts, sysinfo storage, tags, groups, online tracker |
| `internal/clientapi` | Client listener handlers (uses Phase 0 `wire` types) |
| `internal/adminapi` | Admin JSON handlers, middleware (session, CSRF, origin, security headers), `openapi.yaml` |
| `internal/connect` | `rustdesk://` link builder and config-string encoder |
| `internal/audit` | `Record(ctx, q, Event)` inside the caller's transaction; list queries |

## Data model

All IDs are `uuid` (generated with `gen_random_uuid()`) and all times are `timestamptz`.

- **users**: `id`, `username` (citext, unique), `display_name`, `email`, `role` (`owner` | `admin`), `password_hash`, `totp_secret_enc` (bytea, null until enrolled), `totp_required` (bool), `status` (`active` | `disabled`), `failed_logins` (int), `locked_until`, `created_at`, `updated_at`. The database keeps at least one active owner: the application checks this inside the same transaction, using `SELECT … FOR UPDATE` on owners.
- **sessions**: `id` (bytea, SHA-256 of the cookie token), `user_id`, `csrf_token`, `mfa_passed` (bool), `ip` (inet), `user_agent`, `created_at`, `last_seen_at`, `expires_at`.
- **servers**: `id`, `name`, `id_host`, `relay_host`, `public_key`, `created_at`, `updated_at`.
- **devices**: `id`, `server_id`, `rustdesk_id` (text), `uuid` (text, the client's base64 value), `state` (`pending` | `approved` | `rejected` | `archived`), `alias`, `hostname`, `os`, `cpu`, `memory`, `client_version`, `username`, `note`, `group_id` (nullable), `presets` (jsonb), `first_seen_at`, `last_seen_at`, `approved_by`, `approved_at`, `updated_at`. Unique on (`server_id`, `rustdesk_id`).
- **device_alerts**: `id`, `device_id`, `kind` (`uuid_mismatch`), `details` (jsonb: `{seen_uuid, ip}`), `created_at`, `resolved_at`, `resolved_by`. At most one unresolved alert per (device, kind), enforced by a partial unique index.
- **device_groups**: `id`, `parent_id` (nullable), `name`. Unique on (`parent_id`, `name`), with NULL parents compared as equal (`NULLS NOT DISTINCT`). Cycles are rejected in the application.
- **tags**: `id`, `name` (citext, unique), `color` (int, ARGB). **device_tags**: (`device_id`, `tag_id`), primary key on both.
- **audit_events**: `id`, `at`, `actor_user_id` (nullable), `actor_ip` (inet), `action` (text, e.g. `device.approved`), `target_type`, `target_id`, `details` (jsonb). A migration revokes UPDATE and DELETE on this table from the app role when that role is not the table owner, and in every case adds a trigger that raises on UPDATE and DELETE.
- **settings**: `key` (text, primary key), `value` (jsonb). Keys: `setup_complete`, `enrollment_policy` (`"approval"`; the only value in Phase 1).

## Client API behavior

The client API serves one server profile. Before setup is complete it answers heartbeat and sysinfo with `{}` and `SYSINFO_UPDATED` and stores nothing.

For both heartbeat and sysinfo, look up (`server_id`, `rustdesk_id`):

| Situation | Effect | Heartbeat reply | Sysinfo reply |
|---|---|---|---|
| Unknown ID, fewer than `MAX_PENDING_DEVICES` pending | Insert `pending` with the request's uuid; audit `device.enrolled` (actor null, actor_ip = client IP) | `{"sysinfo":true}` | Store sysinfo; `SYSINFO_UPDATED` |
| Unknown ID, cap reached | Nothing stored. A throttled audit `device.enroll_dropped` (at most once per 10 min) | `{}` | `SYSINFO_UPDATED` |
| Known, same uuid, `pending` or `approved` | Tracker update (heartbeat); sysinfo fields stored | `{"sysinfo":true}` if no sysinfo stored yet, else `{}` | `SYSINFO_UPDATED` |
| Known, different uuid | Device unchanged. Upsert an open `uuid_mismatch` alert; audit `device.uuid_mismatch` once per open alert | `{}` | `SYSINFO_UPDATED` |
| `rejected` or `archived` | Nothing | `{}` | `SYSINFO_UPDATED` |

Bodies that don't decode, or that lack `id` or `uuid`, get 400 `{"error":"bad request"}`.

**Online tracker:** in memory, a map from `rustdesk_id` to `{last_heartbeat, conns}`, safe for concurrent use.
- A device is online if `now - last_heartbeat < 45s`.
- A background goroutine flushes changed `last_seen_at` values to the database every 30 s in one batched statement, and once more on shutdown.
- If `HBBS_ADDR` is set, every 60 s it sends `OnlineRequest` for approved devices with no heartbeat in the last 45 s, in batches of 1,000 IDs. A device reported online that way counts as online (source `hbbs`) for 45 s.

**Limits on the client routes** (both listeners):
- 64 KiB body cap.
- Per-IP token bucket: 20/s, burst 40. Over the limit gets 429 `{"error":"rate limited"}`.
- The client IP comes from the immediate peer, or from the rightmost untrusted `X-Forwarded-For` entry when the peer is in `TRUSTED_PROXIES`.

## Admin side

### Setup (`/setup`)

The routes exist only while `setup_complete` is false; afterwards they are 404.
- **Token:** at startup, if setup is not complete, the app generates a 32-byte random token, logs it once (`setup token: …`), and keeps only its SHA-256 in memory. It expires after 24 h; a restart issues a new one. Every setup request carries `X-Setup-Token`, compared in constant time.
- `POST /setup/owner {username, password, display_name, email}` validates the password: at least 12 characters, not in the embedded list of the 10,000 most common passwords, and not equal to the username.
- `POST /setup/owner/totp` returns `{secret, otpauth_url}`. `POST /setup/owner/totp/verify {code}` confirms it.
- `POST /setup/server {name, id_host, relay_host, public_key}` validates the key as base64 of 32 bytes and runs the reachability check, returning `{saved: true, checks: [{name, ok, detail}]}`. It saves even when checks fail.
- `POST /setup/complete` requires a verified owner TOTP and a saved server. It sets `setup_complete`, writes audit `setup.completed`, and returns the client config.

### Client config (`internal/connect`)

- The config string is `reverse(base64url_nopad(JSON {host, relay, api, key}))`, decodable by the client's `get_custom_server_from_config_string`.
- `api` is `http://<id_host>:21114`, or `http://<id_host>:<port>` when `CLIENT_LISTEN_ADDR` has a non-default port.
- The deep link is `rustdesk://config/<string>`.
- Install snippets cover Windows (PowerShell), macOS and Linux and set those four values.

### Admin API (`/admin/api/v1`)

- **Shapes:** JSON; errors are `{"error":{"code":"…","message":"…"}}`; lists take `?limit=` (≤200) and `?cursor=` and return `{items, next_cursor}`.
- **auth:**
  - `POST /auth/login {username, password}` returns `{mfa_required: bool}` and sets the session cookie with `mfa_passed=false`.
  - `POST /auth/totp {code}` sets `mfa_passed`.
  - Also: `POST /auth/logout`, `GET /auth/me`, `POST /auth/password`, `POST /auth/totp/enroll`, `POST /auth/totp/enroll/verify`.
- **users** (Owner): list, create, `PATCH {display_name, email, role, status, totp_required}`, `POST /users/{id}/reset-totp`.
- **devices:** `GET /devices?state=&online=&tag=&group=&os=&q=`, `GET /devices/{id}`, `PATCH /devices/{id} {alias, note, group_id, tag_ids}`, and `POST /devices/{id}/approve|reject|archive|restore`. `POST /devices/{id}/alerts/{alert_id}/resolve {action: "accept_new_uuid"|"dismiss"}` re-pins the uuid on accept.
- **groups:** list (as a tree), create, rename, move, delete (only when empty).
- **tags:** list, create, update, delete (detaches from devices).
- **connect:**
  - `GET /devices/{id}/connect?action=connect|file-transfer|port-forward|terminal&relay=0|1` returns `{url, command, id}`.
  - Links are `rustdesk://<id>` for `connect`, `rustdesk://<action>/<id>` otherwise, with `/r` appended when relay is on.
  - The endpoint audits `device.connect_link` and is approved devices only.
  - No passwords in links.
- **server:** `GET /server`, `PATCH /server`, `POST /server/check`.
- **audit:** `GET /audit?action=&actor=&target=&since=&until=`.
- The spec lives in `internal/adminapi/openapi.yaml`, and a test checks that every route registered on the router is in it.

**Authorization in Phase 1:**
- Owner can do everything.
- Admin can do everything except manage users, edit the server, or touch owner accounts.
- Any endpoint other than auth requires `mfa_passed` whenever the user has TOTP enrolled or `totp_required`. A user with `totp_required` and no enrollment can only reach the TOTP enroll endpoints.

### Security controls

- **Cookie:**
  - `__Host-rdadmin_session`: Secure, HttpOnly, SameSite=Strict, Path=/.
  - The token is 32 random bytes; only its SHA-256 is stored.
  - Sessions expire after 5 min idle and 7 days absolute; browser-session cookies end when the browser closes, and open event streams keep sessions alive. The ID rotates at login and when TOTP passes.
- **CSRF:** every non-GET request needs `X-CSRF-Token` equal to the session's token, and an `Origin` header (or `Referer` when Origin is absent) matching `PUBLIC_URL`'s origin.
- **Lockout:**
  - Per account: 5 consecutive failures lock it for 1 minute. Each further failure doubles the lock, up to 1 hour. A success resets the count.
  - Per IP: 20 failures per 10 minutes gives 429.
  - Wrong-username and wrong-password failures return the same message and take the same time. Unknown usernames still run a dummy Argon2id hash.
- **Headers** on admin responses:
  - `Strict-Transport-Security: max-age=31536000`, unless `DEV_INSECURE`.
  - `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`.
- **Server timeouts** on both listeners:
  - Client: ReadHeader 5 s, Read 10 s, Write 10 s, Idle 60 s.
  - Admin: ReadHeader 5 s, Read 30 s, Write 30 s, Idle 120 s.
- **Audit:** every state-changing admin action writes `audit_events` in the same transaction as the change.
- **Errors:** internal errors are logged with a request ID and returned as `{"error":{"code":"internal","message":"internal error","request_id":…}}`.

## Testing

- Unit tests per package. TOTP uses the RFC 6238 test vectors. Argon2id uses reduced parameters in tests only, through an exported test option.
- Store and integration tests run against real Postgres 16:
  - `store.NewTestDB(t)` creates a database per test package from `TEST_DATABASE_URL`, and skips with a clear message when it is unset.
  - CI runs a `postgres:16` service.
  - `make test-db` starts one locally.
- Client API tests replay `testdata/contracts/derived-1.5.0` heartbeat and sysinfo fixtures, and run `sim.Run` against a live `httptest` client listener.
- Security tests cover:
  - a missing or wrong CSRF token gives 403, and a wrong Origin gives 403;
  - the cookie flags;
  - the lockout schedule (with an injected clock);
  - setup routes require the token and disappear once setup completes;
  - the pending cap;
  - a uuid mismatch never changes the device;
  - the admin listener refuses an http `PUBLIC_URL` without `DEV_INSECURE`;
  - `audit_events` rejects UPDATE.
- **Phase 1a gate (automated, end to end):**
  1. Start both listeners on a test database and finish setup through the API.
  2. Run `rdsim` with 3 devices: all three appear `pending`.
  3. Approve one through the admin API; it reports online.
  4. Its connect endpoint returns `rustdesk://<id>`.
  5. Each step is in `audit_events`.

## Out of scope for 1a

The web UI (1b), OIDC, scoped roles and grants (Phase 2), client login and address books (Phase 2), audit endpoints from clients, webhooks, modes B and C (Phase 3), the heartbeat `disconnect` and strategy push, and backups and metrics (Phase 4).
