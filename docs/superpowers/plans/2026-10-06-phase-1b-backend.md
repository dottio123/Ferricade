# Phase 1b Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web UI everything it needs from the backend before any UI is built: session history, trend history, a dashboard summary, preferences, live events, serving of the embedded UI, and an API contract that is enforced by tests.

**Architecture:**
- New packages: `internal/sessions` (ingestion and queries), `internal/stats` (snapshots, history, summary), `internal/events` (an in-process hub fed by Postgres `LISTEN` and by the online tracker), and `web` (the embedded UI assets).
- Live events come from `pg_notify` in triggers on `audit_events` and `sessions`. Postgres delivers a notification only when its transaction commits, so a rolled-back change is never announced, and no handler has to publish anything itself.
- `openapi.yaml` becomes the enforced contract: every admin API test response is validated against it.

**Tech Stack:** Go 1.27, pgx v5, sqlc v1.31.1, goose, chi, `github.com/pb33f/libopenapi-validator` (OpenAPI 3.1 response validation, tests only), testify.

**Spec:** `docs/superpowers/specs/2026-10-06-phase-1b-web-ui-design.md` (section "Backend additions"). Phase 1a context: `docs/superpowers/specs/2026-10-06-phase-1a-backend-design.md`, `docs/phase-1a-notes.md`, `AGENTS.md`.

## Global Constraints

- Every new admin route lives in the `requireMFA` group of `internal/adminapi/router.go` (owner-only ones in its `requireRole(roleOwner)` group), and is in `openapi.yaml` with complete request and response schemas.
- Admin errors: `{"error":{"code","message"}}`. Client API errors: `{"error":"…"}`. Lists: `{items, next_cursor}`, `?limit=` default 50 and max 200, `?cursor=`.
- Every state-changing admin request is audited in the same transaction, with the actor's user ID and `httpx.ClientIP`.
- The client API treats `audit/conn` like heartbeat. Only a known device whose uuid matches and whose state is `pending` or `approved` is accepted; anything else gets `{}` and nothing is stored. Apply the 64 KiB body cap, the per-IP rate limit, and reject NUL bytes with 400 (`hasNUL`).
- Session `type` codes are 0 remote, 1 file transfer, 2 port forward, 3 camera and 4 terminal. The API names are `remote`, `file_transfer`, `port_forward`, `camera`, `terminal`, and `unknown` (for a null or other code).
- Retention: sessions 365 days after they end; snapshots 90 days; seen nonces 7 days.
- Snapshots: every 5 minutes, aligned to the wall clock (`at` truncated to 5 min, UTC).
- History steps: `24h` → 300 s, `7d` → 3600 s, `30d` → 21600 s.
- Stale sessions: an open session whose `conn_id` has been missing from the device's heartbeat `conns` for more than 60 s is closed, with `ended_at` = `conn_seen_at` and `end_reason` = `stale`.
- SSE: heartbeat comment every 25 s; at most 5 streams per session (the 6th gets 429 `rate_limited`); headers `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`; the write deadline is cleared with `http.ResponseController`.
- Event types: `device.updated`, `device.enrolled`, `device.online`, `device.offline`, `session.started`, `session.updated`, `session.ended`, `audit.created`, `preferences.updated` (and `resync`). Payloads carry IDs only.
- Dashboard module catalog, in this canonical order: `fleet-pulse` (wide), `quick-connect` (medium), `approval-queue` (medium), `needs-attention` (medium), `live-sessions` (medium), `activity-trend` (wide), `fleet-overview` (wide), `recent-sessions` (medium), `session-analytics` (medium), `platform-mix` (small), `admin-activity` (medium).
- Presets, as `id` → enabled modules in order:
  - `homelab`: fleet-pulse, quick-connect, fleet-overview, live-sessions, needs-attention, recent-sessions.
  - `business` (the default): fleet-pulse, approval-queue, needs-attention, activity-trend, live-sessions, fleet-overview, admin-activity, platform-mix.
  - `wall`: fleet-pulse, activity-trend, fleet-overview, live-sessions, session-analytics.
- Threshold defaults: `offline_days` 7 (1–365), `pending_hours` 24 (1–720), `min_client_version` "" (or `^\d+(\.\d+){0,3}$`).
- `fleet-overview` tile limit: 30 approved devices. The summary's `groups` list is always returned; the UI chooses the view.
- Tests needing Postgres follow `AGENTS.md` (`TEST_DATABASE_URL`, `REQUIRE_DB=1`).
- Each task adds its own migration file (`00002` to `00005`, as in the File Structure); never edit a migration that already exists, because local stacks apply them as soon as they are rebuilt.

## Review Focus

1. **Session records out of order or repeated.**
   - The client retries posts, so the same `nonce` can arrive again; a duplicate is ignored.
   - A `close` with no open session is ignored.
   - An auth record (`peer`/`type`) with no open session creates one, with `started_at` = now.
   - Test: `TestIngestOutOfOrderAndDuplicates` (Task 3).
2. **A `conn_id` reused after the client restarts.** A `new` record for a `conn_id` that already has an open session closes the old one (`end_reason` `stale`, `ended_at` = its `conn_seen_at`) and opens a new one. Test: `TestIngestConnIDReuse` (Task 3).
3. **An SSE client that disconnects, or a proxy that buffers.** When the request context ends, the stream's goroutine and hub subscription are released. Events are flushed after each write. Test: `TestEventsStreamReleasesOnDisconnect` (Task 9).
4. **History with gaps** (the server was down). Buckets with no snapshots are omitted, never filled with zeros, so charts show a gap rather than a false drop. Test: `TestHistoryOmitsEmptyBuckets` (Task 5).
5. **Stored preferences naming a module a later version removed.**
   - On GET, unknown IDs are dropped and catalog modules missing from the list are appended as disabled, so a stored layout keeps working across versions.
   - PUT still rejects unknown IDs.
   - Test: `TestPreferencesForwardCompatible` (Task 7).

---

## File Structure

```
internal/store/migrations/00002_sessions.sql          sessions, seen_nonces, notify triggers
internal/store/migrations/00003_snapshots.sql        fleet_snapshots
internal/store/migrations/00004_preferences.sql      user_preferences + notify trigger
internal/store/migrations/00005_audit_notify.sql     audit_events notify trigger
internal/store/queries/sessions.sql, stats.sql, preferences.sql
internal/adminapi/contract_test.go                    response-vs-schema validation for all tests
internal/sessions/{service.go,ingest.go,query.go}     ingestion, staleness, list, stats
internal/stats/{snapshot.go,history.go,summary.go,thresholds.go}
internal/events/{hub.go,listen.go}                    hub; Postgres LISTEN → hub
internal/devices/tracker.go                           + online/offline change callback and sweep
internal/clientapi/handler.go                         + POST /api/audit/conn, heartbeat → session sync
internal/adminapi/{sessions.go,stats.go,prefs.go,events.go,ui.go}
web/assets.go, web/dist/.gitkeep                      embedded UI (package web)
internal/app/app.go                                   wiring: hub, listener, snapshotter, retention, UI
internal/sim/sim.go, cmd/rdsim                        + simulated sessions
internal/e2e/gate_test.go                             + Phase 1b backend gate
```

---

### Task 1: Enforced API contract

**Files:**
- Create: `internal/adminapi/contract_test.go`
- Modify: `internal/adminapi/env_test.go` (`client.do` validates each response), `internal/adminapi/openapi.yaml` (complete schemas), `go.mod`

**Interfaces:**
- Produces: the test helper `validateResponse(t *testing.T, req *http.Request, rec *httptest.ResponseRecorder)`, called by `client.do` for every request under `/admin/api/v1` and `/setup`. It fails the test when the route or method is not in `openapi.yaml`, or when the status or body does not match the response schema declared for that status. A `wantSchemaFailure` escape hatch is allowed only inside `TestContractCatchesMismatch`.

- [ ] **Step 1: Write failing tests.**

```go
func TestContractCatchesMismatch(t *testing.T)   // a hand-built 200 for GET /admin/api/v1/auth/me with body {"user":{"id":"x"}} → validateResponse reports a failure (use a fake testing.TB to capture it)
func TestContractCatchesUnknownStatus(t *testing.T) // 418 for GET /admin/api/v1/devices → failure "status not declared"
func TestContractCoversAllRoutes(t *testing.T)    // keep TestOpenAPICoversRoutes; add: every documented operation declares a 2xx response with a schema, and the error responses use #/components/schemas/Error
```

- [ ] **Step 2: Run** `go test ./internal/adminapi/ -run Contract`. Expected: FAIL (`validateResponse` undefined).
- [ ] **Step 3: Implement.**
  - Load `openapi.yaml` once with `libopenapi` and build a `libopenapi-validator` response validator.
  - Hook it into `client.do`, so every existing adminapi test now validates its responses.
  - Run the whole package. For each failure, fix **the spec**, not the handler: add `required` lists, add `additionalProperties: false` on closed objects, and document missing statuses. Change a handler only if it contradicts the Phase 1a spec, and record each such change as a ruling.
- [ ] **Step 4: Run** `go test -race ./internal/adminapi/...` with the DB env. Expected: PASS, and every existing test is now schema-checked.
- [ ] **Step 5: Commit:** `test(adminapi): validate every response against openapi.yaml`.

---

### Task 2: Online and offline change events from the tracker

**Files:**
- Modify: `internal/devices/tracker.go`
- Test: `internal/devices/tracker_test.go`

**Interfaces:**
- Produces:
  - `(*Tracker).OnChange(fn func(rustdeskID string, online bool))`, which registers one callback. It is called outside the tracker's lock.
  - `(*Tracker).Sweep()`, which reports devices whose online window lapsed since the last sweep.
  - `Run` calls `Sweep` every `SweepEvery = 5 * time.Second`.
- Rules:
  - `Beat` or `MarkOnline` on a device that was not online calls `fn(id, true)` once.
  - `Sweep` calls `fn(id, false)` once for each device that was reported online and is no longer online.
  - A device seen for the first time counts as having been offline.

- [ ] **Step 1: Write failing tests (fake clock).**

```go
func TestTrackerOnChangeOnline(t *testing.T)   // Beat("a") → one (a,true); Beat("a") again within window → no call
func TestTrackerOnChangeOffline(t *testing.T)  // Beat at t0; clock +46s; Sweep → one (a,false); Sweep again → no call
func TestTrackerOnChangeHBBS(t *testing.T)     // MarkOnline(["b"]) → (b,true); +105s Sweep → (b,false)
func TestTrackerOnChangeBackOnline(t *testing.T) // offline reported, then Beat → (a,true) again
```

- [ ] **Step 2: Run** `go test ./internal/devices/ -run OnChange`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep a `reported map[string]bool` under the existing mutex. Collect the transitions while holding the lock, and call the callback after releasing it.
- [ ] **Step 4: Run** `go test -race ./internal/devices/...`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(devices): tracker reports online and offline changes`.

---

### Task 3: Session ingestion

**Files:**
- Create: `internal/store/migrations/00002_sessions.sql`, `internal/store/queries/sessions.sql`, `internal/sessions/service.go`, `internal/sessions/ingest.go`
- Modify: `internal/clientapi/handler.go` (route and heartbeat hook), `internal/app/app.go` (construct the service)
- Test: `internal/sessions/ingest_test.go`, `internal/clientapi/handler_test.go`

**Interfaces:**
- Migration `00002_sessions.sql`:
  - **`sessions`:** `id uuid pk default gen_random_uuid()`, `device_id uuid not null references devices on delete cascade`, `conn_id integer not null`, `rd_session_id numeric(20)` (the client's u64 `session_id`, null when 0), `peer_rustdesk_id text not null default ''`, `peer_name text not null default ''`, `type smallint` (null until known), `client_ip inet`, `started_at timestamptz not null`, `authed_at timestamptz`, `ended_at timestamptz`, `end_reason text check (end_reason in ('closed','stale'))`, `conn_seen_at timestamptz not null`.
  - **Indexes:** a partial unique index `(device_id, conn_id) where ended_at is null`; `(started_at desc, id)`; and `(device_id, started_at desc)`.
  - **`seen_nonces`:** `nonce text pk`, `seen_at timestamptz not null`.
  - **Notify trigger on `sessions`:** after insert → `pg_notify('rdadmin_events', json {"kind":"session","op":"started","session_id","device_id"})`; after update when `ended_at` goes from null to non-null → `"op":"ended"`.
- Produces:
  - `sessions.Service{Pool *pgxpool.Pool; Now func() time.Time}`
  - `(*Service).Ingest(ctx, serverID uuid.UUID, a wire.ConnAudit, ip netip.Addr) error`
  - `(*Service).SyncConns(ctx, serverID uuid.UUID, rustdeskID, devUUID string, conns []int32) error`
  - `sessions.StaleAfter = 60 * time.Second`
  - `clientapi.Deps.Sessions *sessions.Service`. When nil, `audit/conn` answers `{}` and the heartbeat makes no sync call (tests that don't need sessions stay unchanged).
- Ingest rules, all in one transaction:
  1. Identify the device as `devices.Service.identify` does: same `(server_id, rustdesk_id)`, uuid equal, state pending or approved. Otherwise return nil without writing anything. Reuse it by exporting a `devices.Lookup(ctx, q, serverID, rustdeskID, uuid) (deviceID uuid.UUID, ok bool, err error)` from `internal/devices`.
  2. Insert the nonce (`ON CONFLICT DO NOTHING`). If it already existed, stop.
  3. `action == "new"`: if an open session with this `conn_id` exists, close it as stale. Then insert a new session with `started_at` = now, `conn_seen_at` = now, and `client_ip` = the record's `ip` parsed (null when invalid).
  4. No action and `peer` present: update the open session (`peer_rustdesk_id` = `peer[0]`, `peer_name` = `peer[1]`, `type`, `authed_at` = now, and the `rd_session_id`). Create the session first when none is open.
  5. `action == "close"`: set `ended_at` = now and `end_reason` = `closed` on the open session. With none open, do nothing.
- SyncConns, run after a successful heartbeat for the same device:
  - set `conn_seen_at` = now on open sessions whose `conn_id` is in `conns`;
  - then close, as stale, the open sessions not in `conns` whose `conn_seen_at` is older than `StaleAfter`.
- The client route `POST /api/audit/conn` decodes `wire.ConnAudit`. Missing `id`, `uuid` or `nonce`, or any NUL, gives 400 `{"error":"bad request"}`. Before setup, or with nil `Sessions`, it gives 200 `{}`. Otherwise it calls `Ingest` and answers 200 `{}`. An `Ingest` error gives 500 `{"error":"internal error"}` and is logged.

- [ ] **Step 1: Write failing tests** (`sessions` against the test DB; fixtures from `testdata/contracts/derived-1.5.0/audit-conn-{new,auth,close}.json`).

```go
func TestIngestLifecycle(t *testing.T)            // approved device; new → auth → close fixtures → one session: peer "987654321"/"bob", type 0, client_ip 203.0.113.7, started/authed/ended set, end_reason "closed"
func TestIngestOutOfOrderAndDuplicates(t *testing.T) // same nonce twice → one effect; close first → no row; auth first → row with started_at=now; then close → ended
func TestIngestConnIDReuse(t *testing.T)          // new conn 3, then new conn 3 again → first stale (ended_at=its conn_seen_at), second open
func TestIngestRejectsUnknownOrMismatched(t *testing.T) // unknown id, wrong uuid, rejected/archived device → no rows, no error
func TestIngestLargeSessionID(t *testing.T)       // session_id 18446744073709551615 stored and read back exactly
func TestSyncConnsClosesStale(t *testing.T)       // open conn 3; SyncConns([]) at +59s → open; at +61s → stale; SyncConns([3]) keeps conn_seen_at fresh
func TestSessionNotifyOnCommitOnly(t *testing.T)  // LISTEN rdadmin_events on a second conn; insert in a rolled-back tx → no notification; committed insert → one {"kind":"session","op":"started",…}
```

Client API: `TestAuditConnRoute` covers:
- the three fixtures → 200 `{}` and one session;
- a NUL in `peer` → 400;
- before setup → `{}` and no row;
- a heartbeat with `conns: []` 61 s after the last conn → the session closes.

- [ ] **Step 2: Run** the sessions and clientapi tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Write the migration, then the queries (`make sqlc`), the service and the route. Wire `sessions.Service` in `app.New` into `clientapi.Deps`.
- [ ] **Step 4: Run** `go test -race ./internal/sessions/... ./internal/clientapi/... ./internal/devices/...`, then `sqlc diff`. Expected: PASS, and the diff is clean.
- [ ] **Step 5: Commit:** `feat(sessions): ingest RustDesk connection audits into session history`.

---

### Task 4: Sessions admin API

**Files:**
- Create: `internal/sessions/query.go`, `internal/adminapi/sessions.go`
- Modify: `internal/adminapi/router.go`, `internal/adminapi/openapi.yaml`, `internal/adminapi/Deps` (field `Sessions *sessions.Service`)
- Test: `internal/sessions/query_test.go`, `internal/adminapi/sessions_test.go`

**Interfaces:**
- Produces:
  - `sessions.Filter{DeviceID *uuid.UUID; Active *bool; Since, Until time.Time; Limit int; Cursor string}`
  - `(*Service).List(ctx, f Filter) ([]Session, string, error)`, newest `started_at` first, keyset cursor
  - `(*Service).Stats(ctx, rng string, loc *time.Location) (Stats, error)`, where `rng` is `7d` or `30d`
- Routes:
  - `GET /sessions`: query `device_id`, `active` (`true`/`false`), `since`, `until` (RFC 3339), `limit`, `cursor`. Each item:
    `{id, device_id, device_name, rustdesk_id, peer_rustdesk_id, peer_name, type, client_ip (string or null), started_at, authed_at (or null), ended_at (or null), end_reason (or null), duration_seconds}`
    - `device_name` = alias, else hostname, else `rustdesk_id`.
    - `duration_seconds` runs to `ended_at`, or to now while open.
  - `GET /sessions/stats?range=7d|30d&tz=<IANA>` (`tz` defaults to UTC; an invalid one gives 400) →
    `{range, tz, per_day: [{day: "YYYY-MM-DD", count, total_seconds}], average_seconds, top_devices: [{device_id, device_name, count, total_seconds}]}`
    - `per_day` has one entry per day in the range, including zero days, oldest first.
    - `top_devices`: at most 5, by `total_seconds` descending.
    - Open sessions count up to now.
- `import _ "time/tzdata"` in `cmd/rdadmin`: the distroless image has no zoneinfo.

- [ ] **Step 1: Write failing tests**: `TestListSessionsFilters` (device, active, time range, pagination), `TestSessionTypes` (codes 0–4, null and 9 → `remote` … `terminal`, `unknown`, `unknown`), `TestSessionStatsDaysAndTZ` (sessions straddling UTC midnight count on different days for `tz=America/New_York` than for UTC; empty days present), `TestSessionStatsTopDevices`, `TestSessionsRequireMFA`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, including the openapi entries (the contract test from Task 1 enforces them).
- [ ] **Step 4: Run** `go test -race ./internal/sessions/... ./internal/adminapi/...`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(adminapi): session history and session stats`.

---

### Task 5: Snapshots, trend history and retention

**Files:**
- Create: `internal/store/migrations/00003_snapshots.sql`, `internal/store/queries/stats.sql`, `internal/stats/snapshot.go`, `internal/stats/history.go`
- Modify: `internal/app/app.go` (start the snapshotter and retention after setup, next to the tracker), `internal/adminapi/{router.go,stats.go,openapi.yaml}`
- Test: `internal/stats/snapshot_test.go`, `internal/stats/history_test.go`, `internal/adminapi/stats_test.go`

**Interfaces:**
- Migration: `fleet_snapshots(at timestamptz primary key, approved int not null, online int not null, pending int not null, sessions int not null)`.
- Produces:
  - `stats.Snapshotter{Pool; Online func(rustdeskID string) bool; Now func() time.Time}`
  - `(*Snapshotter).Take(ctx, serverID uuid.UUID) error`:
    - inserts at `Now().UTC().Truncate(5*time.Minute)` with `ON CONFLICT DO NOTHING`;
    - `online` counts approved devices that are online;
    - `sessions` counts open sessions of approved devices.
  - `(*Snapshotter).Run(ctx, serverID)`: takes a snapshot at start, then at each 5-minute boundary; also runs `Retain` hourly.
  - `stats.Retain(ctx, pool, now)`: deletes snapshots older than 90 days, sessions ended more than 365 days ago, and nonces older than 7 days.
  - `stats.History(ctx, pool, rng string, now time.Time) (HistoryResult, error)`
- Route: `GET /stats/history?range=24h|7d|30d` → `{range, step_seconds, points: [{at, approved, online, pending, sessions}]}`.
  - Buckets are `at` truncated to the step. Over the bucket's snapshots, `approved`, `online` and `pending` are the rounded average and `sessions` is the maximum.
  - Only buckets that have snapshots are returned, oldest first.
  - A bad range gives 400.

- [ ] **Step 1: Write failing tests**: `TestSnapshotTakeAligned` (taken at 10:07:30 → `at` 10:05; taking again in the same slot is a no-op), `TestSnapshotCounts` (approved, online via the fake, pending, open sessions), `TestHistoryDownsample` (12 snapshots in one hour with `range=7d` → one point with the rounded average and the max sessions), `TestHistoryOmitsEmptyBuckets`, `TestRetain` (boundaries exactly at 90 d, 365 d and 7 d are kept; one microsecond older is deleted), `TestHistoryEndpoint` (shape, bad range 400).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, and wire it in `app.startTracker` (same server ID, same lifetime).
- [ ] **Step 4: Run** `go test -race ./internal/stats/... ./internal/adminapi/... ./internal/app/...`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(stats): five-minute fleet snapshots, trend history and retention`.

---

### Task 6: Dashboard summary and owner thresholds

**Files:**
- Create: `internal/stats/summary.go`, `internal/stats/thresholds.go`
- Modify: `internal/adminapi/{stats.go,router.go,openapi.yaml}`
- Test: `internal/stats/summary_test.go`, `internal/adminapi/stats_test.go`

**Interfaces:**
- Produces:
  - `stats.Thresholds{OfflineDays int; PendingHours int; MinClientVersion string}`, stored in the settings key `dashboard_thresholds`, with defaults per Global Constraints.
  - `stats.LoadThresholds(ctx, q) (Thresholds, error)` and `stats.SaveThresholds(ctx, q, t) error` (validates).
  - `stats.Summary(ctx, pool, online func(string) bool, now time.Time) (SummaryResult, error)`.
  - `stats.CompareVersions(a, b string) int`: numeric by part, where a missing part is 0 and a non-numeric part sorts as 0.
- Routes:
  - `GET /stats/summary` →
    ```
    {generated_at,
     devices: {approved, pending, rejected, archived, online},
     sessions: {active},
     alerts: {open},
     os: [{name, count}],
     versions: [{version, count, outdated}],
     groups: [{id (or null), name, online, total}],
     attention: [{kind, device_id, rustdesk_id, name, since, detail}]}
    ```
    - `os.name` is from the text before `" / "` in `devices.os`, mapped case-insensitively: windows → `Windows`, linux → `Linux`, macos → `macOS`, android → `Android`, anything else → `Other`.
    - `os`, `versions` and `groups` count approved devices only. `groups` includes an `{id: null, name: "Ungrouped"}` entry when it is non-empty, and is sorted by name with Ungrouped last.
    - `attention` kinds:
      - `uuid_mismatch`: an open alert; `since` = the alert's `created_at`.
      - `pending_long`: pending for longer than `pending_hours`; `since` = `first_seen_at`.
      - `offline_long`: approved and not online, with `last_seen_at` older than `offline_days`; `since` = `last_seen_at`.
      - `outdated_client`: approved and below `min_client_version` (only when it is set).
      - Sorted by kind in that order, then oldest `since`. At most 50 entries.
  - `GET /settings/dashboard` → `{offline_days, pending_hours, min_client_version}`, for any admin.
  - `PUT /settings/dashboard`, owner only. Validation failures give 400 `bad_request` with the field named. It audits `settings.dashboard_updated` with before and after.

- [ ] **Step 1: Write failing tests**: `TestSummaryCounts`, `TestSummaryOSMapping` (`"windows / Windows 11 Pro - 11 (26200)"` → Windows; `"Ubuntu / 24.04"` → Other; `"linux / Debian"` → Linux), `TestSummaryAttention` (one of each kind at threshold ± 1 s; ordering; cap 50), `TestCompareVersions` (`1.5.0` vs `1.4.9` → 1; `1.5` = `1.5.0`; `1.10.0` > `1.9.9`), `TestThresholdsValidateAndAudit`, `TestThresholdsOwnerOnly`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test -race ./internal/stats/... ./internal/adminapi/...`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(stats): dashboard summary and owner thresholds`.

---

### Task 7: Preferences and the dashboard catalog

**Files:**
- Create: `internal/store/migrations/00004_preferences.sql`, `internal/store/queries/preferences.sql`
- Modify: `internal/adminapi/{prefs.go,router.go,openapi.yaml}`
- Test: `internal/adminapi/prefs_test.go`

**Interfaces:**
- Migration: `user_preferences(user_id uuid primary key references users on delete cascade, prefs jsonb not null, updated_at timestamptz not null)`, plus a notify trigger after insert or update → `pg_notify('rdadmin_events', {"kind":"prefs","user_id"})`.
- Routes:
  - `GET /dashboard/catalog` → `{modules: [{id, size}], presets: [{id, name, modules: [ids]}]}`.
    - Values are from Global Constraints. The preset names are `Homelab`, `Business` and `Monitoring wall`.
    - This is the only place the catalog is defined; the UI reads it from here.
  - `GET /me/preferences` → `{preset, modules: [{id, enabled}], pinned_device_ids, theme, density}`.
    - With nothing stored, it returns the `business` preset: its modules enabled, in order, followed by the remaining catalog modules disabled, in catalog order; `pinned_device_ids` `[]`, `theme` `system`, `density` `comfortable`.
    - Stored preferences are made forward-compatible (Review Focus 5).
    - Pinned IDs of devices that no longer exist or are not approved are dropped on read.
  - `PUT /me/preferences` replaces the stored preferences:
    - `preset` is one of `homelab`, `business`, `wall` or `custom`;
    - `modules` has known IDs and no duplicates;
    - `pinned_device_ids`: at most 24, unique UUIDs;
    - `theme` is `dark`, `light` or `system`; `density` is `comfortable` or `compact`;
    - the body is at most 16 KiB.
    - It returns the normalized preferences, as GET would. It is not audited (it is a personal setting, not an admin change).

- [ ] **Step 1: Write failing tests**: `TestCatalog`, `TestPreferencesDefault`, `TestPreferencesRoundTrip`, `TestPreferencesValidation` (unknown module, duplicate, 25 pins, bad theme, 17 KiB → 400 each), `TestPreferencesForwardCompatible` (store raw JSON with `"retired-module"` and missing `platform-mix` → GET drops the first and appends the second disabled), `TestPreferencesPerUser`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test -race ./internal/adminapi/...` and `sqlc diff`. Expected: PASS, and the diff is clean.
- [ ] **Step 5: Commit:** `feat(adminapi): dashboard catalog and per-admin preferences`.

---

### Task 8: Event hub fed by Postgres and the tracker

**Files:**
- Create: `internal/events/hub.go`, `internal/events/listen.go`
- Create: `internal/store/migrations/00005_audit_notify.sql`
- Modify: `internal/app/app.go`
- Test: `internal/events/hub_test.go`, `internal/events/listen_test.go`

**Interfaces:**
- Trigger: after insert on `audit_events` → `pg_notify('rdadmin_events', json {"kind":"audit","audit_id","action","target_type","target_id"})`.
- Produces:
  - `events.Event{Type string; DeviceID, SessionID, AuditID, UserID string}`, with JSON tags `type`, `device_id`, `session_id`, `audit_id`, `user_id` (omitempty).
  - `events.NewHub() *Hub`.
  - `(*Hub).Publish(e Event)`, which never blocks.
  - `(*Hub).Subscribe(userID string) (<-chan Event, func())`:
    - the buffer holds 64 events;
    - a subscriber whose buffer is full gets its channel closed (it must reconnect and refetch);
    - `preferences.updated` goes only to subscribers with the same `userID`.
  - `events.Listen(ctx, pool, hub, log)`:
    - holds a dedicated connection with `LISTEN rdadmin_events` and maps the notifications;
    - **audit** → `audit.created{audit_id}`; with `target_type` `device` also → `device.updated{device_id}`; with action `device.enrolled` also → `device.enrolled{device_id}`;
    - **session** → `session.started`, `session.updated` or `session.ended` `{session_id, device_id}`;
    - **device** → `device.updated{device_id}` (sysinfo fields changed; migration `00006`);
    - **prefs** → `preferences.updated{user_id}`;
    - reconnects with backoff from 1 s doubling to 30 s, and logs each reconnect at WARN.
  - App wiring:
    - the tracker's `OnChange` → `device.online` / `device.offline` with `device_id`. The tracker knows `rustdesk_id`, so map it to the device ID with a cached lookup query `GetDeviceIDByRustdeskID(server_id, rustdesk_id)`;
    - `app.Hub()` is exposed for tests.

- [ ] **Step 1: Write failing tests**: `TestHubFanOut`, `TestHubSlowSubscriberClosed`, `TestHubPreferencesOnlyToOwner`, `TestHubUnsubscribe`, `TestListenMapsAuditAndSession` (insert an audit row for `device.approved` → `audit.created` and `device.updated`; `device.enrolled` → also `device.enrolled`; a session insert → `session.started`), `TestListenReconnects` (terminate the listener's backend with `pg_terminate_backend` → events flow again within 5 s).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test -race ./internal/events/... ./internal/app/...`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(events): event hub fed by Postgres notifications and the online tracker`.

---

### Task 9: SSE endpoint

**Files:**
- Create: `internal/adminapi/events.go`
- Modify: `internal/adminapi/{router.go,openapi.yaml}`, `adminapi.Deps` (`Hub *events.Hub`)
- Test: `internal/adminapi/events_test.go`

**Interfaces:**
- Route: `GET /admin/api/v1/events` (requireMFA).
  - Headers per Global Constraints. Clear the write deadline with `http.NewResponseController(w).SetWriteDeadline(time.Time{})`.
  - The first line is `retry: 3000`.
  - Each event is written as `event: <type>\ndata: <json>\n\n` and then flushed.
  - A `: ping` comment is sent every 25 s.
  - At most 5 concurrent streams per session ID; the 6th gets 429 `rate_limited`.
  - When the hub closes the subscription, the handler writes `event: resync\ndata: {}\n\n` and returns.
  - In `openapi.yaml`, it is documented with a `text/event-stream` response. The contract validator skips body validation for that media type.

- [ ] **Step 1: Write failing tests** (with a real `httptest.Server`, so streaming works):
  - `TestEventsStreamDelivers`: approve a device → `device.updated` arrives within 2 s.
  - `TestEventsRequireAuthAndMFA`.
  - `TestEventsStreamCap`: the 6th stream gets 429.
  - `TestEventsStreamReleasesOnDisconnect`: cancel the client → the hub's subscriber count returns to 0 within 1 s. Expose an `(*Hub).Subscribers() int` used only by tests.
  - `TestEventsResyncWhenSlow`.
  - `TestEventsSurviveWriteTimeout`: an admin server with `WriteTimeout` 1 s; the stream stays open for 3 s and gets a ping. Use a 300 ms ping interval in this test, via `Deps.EventsPing`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test -race ./internal/adminapi/...`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(adminapi): server-sent event stream`.

---

### Task 10: Serve the embedded web UI

**Files:**
- Create: `web/assets.go` (package `web`), `web/dist/.gitkeep`, `internal/adminapi/ui.go`
- Modify: `internal/adminapi/router.go`, `.gitignore` (add `web/dist/*` and `!web/dist/.gitkeep`), `internal/app/app.go`
- Test: `internal/adminapi/ui_test.go`

**Interfaces:**
- `web/assets.go`:
  ```go
  //go:embed all:dist
  var dist embed.FS
  func Assets() (fs.FS, bool) // the dist sub-FS; false when dist/index.html is absent
  ```
- `adminapi.Deps.UI fs.FS`. When nil, the placeholder is served.
- `GET /setup/status` → `{"setup_complete": bool}`:
  - unauthenticated, needs no setup token, and stays available after setup (unlike the other `/setup` routes, which return 404 then);
  - tells the UI whether to show the setup wizard or sign-in;
  - in `openapi.yaml`.
- Router changes:
  - Replace `r.Mount("/", d.ClientRoutes)` with `r.Handle("/api/*", d.ClientRoutes)` and `r.Handle("/healthz", d.ClientRoutes)`.
  - Add `r.Handle("/*", uiHandler)` after the API and setup routes.
  - Unknown paths under `/admin/api/v1/` and `/setup/` keep their JSON 404s.
- `uiHandler`:
  - **Methods:** GET and HEAD only, otherwise 405 JSON.
  - **Assets:** a path under `/assets/` that exists is served with `Cache-Control: public, max-age=31536000, immutable`; a missing asset gives 404.
  - **Other paths:** `index.html` with `Cache-Control: no-store` and `Content-Type: text/html; charset=utf-8`.
  - **No UI:** with `UI` nil, 200 `text/plain`: `rdadmin: the web UI is not built into this binary. Build it with "npm ci && npm run build" in web/, then rebuild rdadmin.`
  - The security headers and CSP apply as they do to every admin response.

- [ ] **Step 1: Write failing tests** with an `fstest.MapFS`:
  - `TestUIIndexFallback`: `/` and `/devices/abc` → `index.html`, with no-store.
  - `TestUIAssetsImmutable`.
  - `TestUIMissingAsset404`.
  - `TestUIPlaceholder`.
  - `TestUIDoesNotShadowAPI`: `/admin/api/v1/nope` → JSON 404; `/setup/x` → JSON 404; `/api/heartbeat` still reaches the client API; `/healthz` → `ok`.
  - `TestUIPostIs405`.
  - `TestUIHasCSP`.
  - `TestSetupStatus`: false before setup with no token; true after; never 401 or 404.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** In `app.New`, pass `web.Assets()` (nil when absent).
- [ ] **Step 4: Run** `go test -race ./...`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: serve the embedded web UI from the admin listener`.

---

### Task 11: Simulated sessions and the backend gate

**Files:**
- Modify: `internal/sim/sim.go`, `cmd/rdsim/main.go`, `internal/e2e/gate_test.go`, `README.md` (short "Live updates and sessions" note in the API section)
- Test: `internal/sim/sim_test.go`, `internal/e2e/gate_test.go`

**Interfaces:**
- `sim.Options.SessionEvery time.Duration` (0 = off) and `sim.Options.SessionLength time.Duration` (default 30 s). Each device, at its own random offset, posts the three `audit/conn` records (`new`, auth with `peer` `["900000000","sim-peer"]` and type 0, `close` after `SessionLength`). Its heartbeats carry `conns: [connID]` while the session is open.
- `rdsim` flags: `-sessions <every>` and `-session-length <d>`.
- `sim.Stats.Sessions int64`: the number of sessions opened.

- [ ] **Step 1: Write failing tests:**
  - `TestSimSessions`: 2 devices, `SessionEvery` 100 ms, `SessionLength` 150 ms, run for 600 ms against an `httptest` server that records requests → each device posts new, auth and close, with `conns` set in between.
  - Extend `TestPhase1aGate` into `TestPhase1bBackendGate`. After the Phase 1a steps:
    1. subscribe to `/admin/api/v1/events`;
    2. run `rdsim` with sessions for 1 device;
    3. `session.started` arrives;
    4. `GET /sessions?active=true` lists it;
    5. `GET /stats/summary` shows `sessions.active` 1;
    6. after `close`, `session.ended` arrives and `GET /sessions/stats?range=7d` counts 1;
    7. `GET /stats/history?range=24h` has at least one point (call `Snapshotter.Take` directly);
    8. `GET /` returns the placeholder text.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test -race ./...` and `sqlc diff`, then `docker compose … up -d --build` and `rdsim -devices 3 -sessions 20s -duration 2m` against the local stack. Expected: tests PASS; the sessions appear in `GET /sessions`.
- [ ] **Step 5: Commit:** `feat(sim): simulated sessions; Phase 1b backend gate`.
