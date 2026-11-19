# Client Policies and Access Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> In this repo the Project Lead turns each task below into a task file `docs/orchestration/tasks/tNNN.md`
> (t111 onward) for Codex or Gemini, per `docs/orchestration/ORCHESTRATION.md`.

**Goal:** rdadmin pushes per-group client policies to stock RustDesk 1.5.0 clients through the heartbeat
`strategy`, and owners/admins open time-limited access windows per device.

**Architecture:** A pure package `internal/policies` validates settings against Deployment Assist's catalog,
overlays an open window, and versions the effective settings; a `policies.Service` (Postgres, audit in the
same transaction) owns policies, the fleet switch, group assignment, windows and device status. The client
API's heartbeat asks the service for the strategy of an identified, approved device; the admin API exposes
CRUD, the switch, windows and status; the web UI adds a Client policies page, a group picker and device-panel
controls.

**Tech Stack:** Go (chi, pgx, sqlc, goose, testify), Postgres 16, React 19 + TanStack Router/Query,
openapi-fetch, MSW mocks, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-17-client-policies-design.md` (approved 2026-10-17).

## Global Constraints

- Branch base for every task: `feature/client-policies`; every PR targets `feature/client-policies`, never main.
- Pushable keys = exactly the keys of `internal/deploy/catalog.json` (`deploy.Catalog()`); values must be in
  that key's catalog values. Nothing else is ever sent (API validation **and** a heartbeat filter).
- Access baseline keys, required in every policy: `approve-mode`, `verification-method`.
- Window override: `approve-mode = password-click`, `verification-method = use-both-passwords`.
- Initial Default policy: `{"approve-mode":"password-click","verification-method":"use-both-passwords"}`.
- Window durations: 60, 240, 480 minutes, or null (until switched off).
- Always reachable ⇔ baseline `approve-mode` ∈ {`password`,`password-click`} and `verification-method` ∈
  {`use-permanent-password`,`use-both-passwords`}.
- Fleet switch `push_enabled` defaults to false; only owners may change it.
- Unconfirmed-close alert after 5 minutes; alert kind `access_window_unconfirmed`.
- Strategy only for **approved** devices and only while push is on; otherwise the heartbeat reply is unchanged.
- No password, PIN or other secret in any heartbeat reply.
- Migration number: `00013`. Never edit an applied migration; never edit `internal/store/db` (run `make sqlc`).
- Every admin change audited in the same transaction. Admin API errors `{"error":{"code","message"}}`.

## Review Focus

1. **Window boundary:** a heartbeat exactly at `ends_at` must already get the baseline (window closed at
   `now >= ends_at`), even if the sweep has not run. → Task 1 test `TestWindowOpenBoundary`; Task 4 gate step.
2. **Non-catalog key stored in the database** (e.g. written by hand or by an older build): the heartbeat
   must never send it. → Task 1 test `TestEffectiveFiltersUnknownKeys`.
3. **Device not trusted** (rustdesk ID with a different uuid, or a pending/rejected/archived device): no
   strategy, no `modified_at`. → Task 4 test `TestHeartbeatStrategyOnlyForApprovedTrustedDevice`.
4. **Group deleted or moved** while it carries a policy, and nested groups three levels deep: the device
   falls back up the chain and finally to Default. → Task 2 test `TestResolveDevicePolicyChain`.
5. **User reads a device they are not granted:** `GET /devices/{id}/policy` answers 404 exactly like
   `GET /devices/{id}`. → Task 3 roles test entries + Task 5 test `TestDevicePolicyStatusScope`.

---

### Task 0: Real-client check (throwaway, t111, Codex Luna low)

Not merged. Proves the stock client applies a strategy and echoes `modified_at` before anything is built.

**Files:**
- Modify (throwaway branch `spike/strategy-check` from `feature/client-policies`):
  `internal/clientapi/handler.go` (heartbeat).

- [ ] **Step 1:** In `heartbeat`, after the existing reply is built, set `resp.ModifiedAt = &v` with
  `v := int64(1791900000)` and `resp.Strategy = &wire.Strategy{ConfigOptions: map[string]string{"enable-file-transfer": "N"}}`,
  and log `h.d.Log.Info("spike: heartbeat", "id", hb.ID, "reported_modified_at", hb.ModifiedAt)`.
- [ ] **Step 2:** `go build ./...` and `go vet ./...` pass; commit to `spike/strategy-check`; do not open a PR.
- [ ] **Step 3 (user):** run the branch on the test server (`..\rdadmin-test`, dev stack), wait 30 s, then
  check on a real 1.5.0 client: Settings → Security → Permissions shows file transfer **off**, and the
  server log shows `reported_modified_at=1791900000` on a later heartbeat. Report both. If either fails,
  stop: the design is revisited.

### Task 1: Pure policy logic (t112, Codex Luna medium)

**Files:**
- Create: `internal/policies/policies.go`, `internal/policies/policies_test.go`

**Interfaces:**
- Consumes: `deploy.Catalog() []deploy.Setting` (keys, `Values`, `Type`; bool settings take `Y`/`N`).
- Produces:
  - `type Settings map[string]string`
  - `var AccessKeys = []string{"approve-mode", "verification-method"}`
  - `type ValidationError struct{ Field, Msg string }` (implements `error` as `Field + ": " + Msg`)
  - `func Validate(s Settings) error` — unknown key → `ValidationError{Field: key, Msg: "not a catalog setting"}`;
    bad value → `{key, "not an allowed value"}`; missing access key → `{key, "required"}`.
  - `func DefaultSettings() Settings` — the initial Default policy.
  - `func WindowOverride() Settings`
  - `func AlwaysReachable(s Settings) bool`
  - `type Window struct{ EndsAt, ClosedAt *time.Time }`
  - `func (w *Window) OpenAt(now time.Time) bool` — nil receiver → false; closed → false; `EndsAt != nil && !now.Before(*EndsAt)` → false.
  - `func Effective(policy Settings, w *Window, now time.Time) Settings` — copy, overlay `WindowOverride()`
    when `w.OpenAt(now)`, then drop every key not in the catalog.
  - `func Version(s Settings) int64` — SHA-256 of the JSON object with keys sorted (Go's `encoding/json` sorts
    map keys), first 8 bytes big-endian, `& math.MaxInt64`, 0 → 1.

- [ ] **Step 1: Write the failing tests**: `TestValidate` (table: unknown key, bad enum value, bad bool `"yes"`,
  missing `approve-mode`, missing `verification-method`, valid full and minimal sets),
  `TestDefaultSettingsValidAndReachable` (`Validate(DefaultSettings()) == nil`, `AlwaysReachable` true),
  `TestAlwaysReachable` (click → false; `use-temporary-password` → false; `password` + `use-permanent-password` → true),
  `TestWindowOpenBoundary` (open at `ends-1ns`, closed at `ends` and after; nil `EndsAt` open; `ClosedAt` set → closed),
  `TestEffectiveOverlay` (policy `click`/`use-temporary-password` + open window → override values, other keys kept;
  expired window → policy values), `TestEffectiveFiltersUnknownKeys` (`"custom-rendezvous-server"` and
  `"api-server"` in the input never appear in the output), `TestVersion` (same map in different insertion order
  → same version; one value changed → different; always > 0).
- [ ] **Step 2:** `go test ./internal/policies/` → FAIL (package missing).
- [ ] **Step 3:** Implement the interfaces above in `internal/policies/policies.go`.
- [ ] **Step 4:** `go test ./internal/policies/` → PASS; `gofmt -l .` empty; `go vet ./...` clean.
- [ ] **Step 5:** Commit `feat(policies): validate, overlay and version client settings`.

### Task 2: Schema, queries and the policies service core (t113, Codex Sol medium)

**Files:**
- Create: `internal/store/migrations/00013_client_policies.sql`, `internal/store/queries/policies.sql`,
  `internal/policies/service.go`, `internal/policies/service_test.go`
- Modify: `internal/store/store_test.go` (new tables), generated `internal/store/db/*` via `make sqlc`

**Interfaces:**
- Consumes: Task 1 (`Settings`, `Validate`, `DefaultSettings`, `Window`, `Effective`, `Version`,
  `AlwaysReachable`); `store.Tx`; `audit.Record`; `devices.Actor`.
- Produces (`internal/policies/service.go`):
  - `type Service struct{ Pool *pgxpool.Pool; Now func() time.Time }`
  - `type Policy struct{ ID uuid.UUID; Name string; IsDefault bool; Settings Settings; UpdatedAt time.Time; UpdatedBy *uuid.UUID }`
  - Errors: `ErrNotFound`, `ErrNameTaken`, `ErrInUse`, `ErrDefaultPolicy`
  - `List(ctx) ([]Policy, error)`, `Get(ctx, id) (Policy, error)`,
    `Create(ctx, a devices.Actor, name string, s Settings) (Policy, error)`,
    `Update(ctx, a devices.Actor, id uuid.UUID, name *string, s *Settings) (Policy, error)` (renaming Default → `ErrDefaultPolicy`),
    `Delete(ctx, a devices.Actor, id uuid.UUID) error` (Default → `ErrDefaultPolicy`; used by a group → `ErrInUse`)
  - `PushEnabled(ctx) (enabled bool, updatedAt time.Time, updatedBy *uuid.UUID, err error)`,
    `SetPushEnabled(ctx, a devices.Actor, enabled bool) error`
  - `SetGroupPolicy(ctx, a devices.Actor, groupID uuid.UUID, policyID *uuid.UUID) error`
  - `type Resolved struct{ Policy Policy; Source string /* "group"|"parent_group"|"default" */; SourceGroupID *uuid.UUID; SourceGroupName string }`
  - `ResolveDevice(ctx, deviceID uuid.UUID) (Resolved, error)`, `ResolveGroup(ctx, groupID uuid.UUID) (Resolved, error)`

**Migration `00013` (exact):** tables `client_policies`, `client_policy_settings` (single row, `push_enabled`
false), `access_windows`, column `device_groups.policy_id`, column `devices.strategy_version_seen bigint`, as in
the spec's Data section; seed the Default policy (`DefaultSettings()` as JSON) and the settings row; partial
unique indexes (one default policy; one open window per device); `device_alerts` kind CHECK widened to
`('uuid_mismatch','access_window_unconfirmed')`; replace trigger `devices_notify_updated` so its WHEN also fires
on `strategy_version_seen` changes; new trigger `access_windows_notify` (AFTER INSERT OR UPDATE) sending
`{'kind':'device','op':'updated','device_id':NEW.device_id}` on `rdadmin_events`. Down migration reverses all.

**Queries (`policies.sql`):** `ListPolicies`, `GetPolicy`, `CreatePolicy`, `UpdatePolicy`, `DeletePolicy`,
`CountGroupsUsingPolicy`, `GetPolicyPush`, `SetPolicyPush`, `SetGroupPolicy`, `ResolveDevicePolicy` and
`ResolveGroupPolicy` (one recursive CTE each: walk `parent_id` from the group upward, first group with a
`policy_id` wins with its depth (0 = `group`, >0 = `parent_group`); none → the default policy, `default`).

- [ ] **Step 1: Write the failing tests** (`service_test.go`, DB tests skip without `TEST_DATABASE_URL`):
  `TestPolicyCRUDAudited` (create/update/delete each write one audit row: `policy.created`, `policy.updated`,
  `policy.deleted`), `TestPolicyValidation` (Create with an unknown key → `*ValidationError`),
  `TestNameTaken`, `TestDefaultPolicyProtected` (delete and rename → `ErrDefaultPolicy`),
  `TestDeletePolicyInUse` (→ `ErrInUse`), `TestPushSwitchAudited` (`policy_push.enabled` / `.disabled`; default false),
  `TestResolveDevicePolicyChain` (grandchild → child → root with policy on root only = `parent_group` + root;
  policy moved to child = `parent_group` + child; device without group = `default`; group policy cleared →
  `default`), `TestSetGroupPolicyAudited` (`group.updated` with details `{"policy_id":…}`); store test:
  the migration applies and reverts cleanly, seeds exactly one default and one settings row.
- [ ] **Step 2:** go gate → the new tests FAIL.
- [ ] **Step 3:** Write the migration and queries, `make sqlc`, implement the service.
- [ ] **Step 4:** go gate (`docs/orchestration/tasks/go-gate.sh`) → PASS; `sqlc diff` empty.
- [ ] **Step 5:** Commit `feat(policies): schema, queries and service core`.

### Task 3: Admin API — policies, push switch, group policy (t114, Codex Sol medium)

**Files:**
- Modify: `internal/adminapi/openapi.yaml`, `internal/adminapi/router.go`, `internal/adminapi/groups.go`,
  `internal/adminapi/errors.go`, `internal/adminapi/roles_test.go`
- Create: `internal/adminapi/policies.go`, `internal/adminapi/policies_test.go`
- Modify: `internal/app/app.go` (construct `policies.Service`, pass it in the admin API deps), `web/src/api/schema.d.ts` (`npm run gen:api`)

**Interfaces:**
- Consumes: Task 2 `policies.Service`.
- Produces (contract, exact names): schemas `Policy {id, name, is_default, settings, updated_at, updated_by}`
  (`updated_by` = the existing actor shape used by `DeploymentSecretState.set_by`), `PolicyCreate {name, settings}`,
  `PolicyPatch {name?, settings?}`, `PolicyPush {enabled, updated_at, updated_by}`; `Group` gains
  `policy_id: uuid|null` and read-only `effective_policy_id: uuid`. Routes: `GET /policies`, `POST /policies`,
  `GET/PATCH/DELETE /policies/{id}`, `GET /settings/policy-push` (owner, admin), `PUT /settings/policy-push`
  (owner), `PATCH /groups/{id}` accepts `{name?, policy_id?}`. New error codes: `in_use` (409),
  `default_policy` (409); `name_taken` (409) reused; validation → 400 `bad_request` with the field in the message.

- [ ] **Step 1: Write the failing tests:** `policies_test.go` (status codes and bodies for every route and error
  above; `settings` round-trips), `roles_test.go` (`add("forbidden", …)` for Users on every new write; Admin
  forbidden on `PUT /settings/policy-push`), `groups` test: PATCH with only `policy_id` keeps the name.
- [ ] **Step 2:** go gate → FAIL.
- [ ] **Step 3:** Contract YAML first, then handlers and routes; `npm run gen:api` in `web/`.
- [ ] **Step 4:** go gate → PASS; `cd web; npm run gen:api:check; npm run typecheck` → exit 0.
- [ ] **Step 5:** Commit `feat(adminapi): client policies, push switch and group policy`.

### Task 4: Heartbeat enforcement (t115, Codex Sol high)

**Files:**
- Modify: `internal/policies/service.go` (+ test), `internal/store/queries/policies.sql`,
  `internal/clientapi/handler.go` (+ `Deps.Policies *policies.Service`), `internal/clientapi/handler_test.go`
  (or the existing heartbeat test file), `internal/sim/sim.go` (+ test), `internal/e2e/gate_test.go`,
  `internal/app/app.go`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: `func (s *Service) Strategy(ctx context.Context, serverID uuid.UUID, rustdeskID, devUUID string, reported int64) (*wire.Strategy, *int64, error)`
  — nil, nil when push is off or the device is not found by (server, rustdesk id, uuid) or not `approved`;
  otherwise `Effective(resolved settings, open window, Now())`, its `Version`, and it stores `reported` in
  `devices.strategy_version_seen` when different. Query `GetDeviceStrategyInputs` returns device id, state,
  resolved settings and the open window in **one** round trip. `internal/sim` keeps the last `modified_at`
  from each reply and sends it on the next heartbeat; `sim.Stats` gains `StrategiesSeen int64`.

- [ ] **Step 1: Write the failing tests:** `TestHeartbeatStrategyOnlyForApprovedTrustedDevice` (pending,
  rejected, archived, wrong uuid, push off → reply has no `strategy` and no `modified_at`),
  `TestHeartbeatStrategyApprovedDevice` (approved + push on → `strategy.config_options` equals the Default
  settings and `modified_at` = `policies.Version` of them), `TestHeartbeatReportsVersionSeen` (second
  heartbeat with that `modified_at` sets `strategy_version_seen`; unchanged value → no UPDATE, checked via
  the row's `xmin` or an update counter), `TestHeartbeatWindowExpiresAtBoundary` (window `ends_at` = now →
  baseline sent without running any sweep), sim test (replays `modified_at`), gate step in `gate_test.go`:
  push on, rdsim devices report the current version within two heartbeats.
- [ ] **Step 2:** go gate → FAIL.
- [ ] **Step 3:** Implement `Strategy`, wire `Deps.Policies` in `heartbeat` after `Devices.Heartbeat`
  (an error is logged and the reply is sent without a strategy), update `internal/sim`.
- [ ] **Step 4:** go gate → PASS; `cd web; npm run e2e:live` → passes (heartbeat path changed).
- [ ] **Step 5:** Commit `feat(clientapi): push client policies in the heartbeat reply`.

### Task 5: Access windows, device status, sweep and alert (t116, Codex Sol high)

**Files:**
- Modify: `internal/policies/service.go` (+ test), `internal/store/queries/policies.sql`,
  `internal/adminapi/openapi.yaml`, `internal/adminapi/router.go`, `internal/adminapi/policies.go` (+ test),
  `internal/adminapi/roles_test.go`, `internal/adminapi/errors.go`, `internal/app/app.go`, `web/src/api/schema.d.ts`
- Consumes: `sessions.Service` for disconnect-on-close (add `RequestDisconnectDevice(ctx, a devices.Actor, deviceID uuid.UUID) error` marking every open session of the device, reusing what `RequestDisconnect` does per session).

**Interfaces:**
- Produces:
  - `OpenWindow(ctx, a devices.Actor, deviceID uuid.UUID, minutes *int, disconnectOnClose bool) (Window row, error)`
    — errors `ErrWindowOpen`, `ErrPushOff`, `ErrAlwaysReachable`, `ErrNotApproved`; audit `access_window.opened`.
  - `CloseWindow(ctx, a devices.Actor, deviceID uuid.UUID, disconnect bool) error` — `ErrNotFound` when none open;
    audit `access_window.closed` `{reason:"manual", disconnect}`.
  - `SweepExpired(ctx) (closed int, err error)` — closes windows with `ends_at <= now` (`close_reason='expired'`,
    no actor, audit with no actor, disconnect when `disconnect_on_close`); opens `access_window_unconfirmed`
    alerts for devices whose window closed ≥ 5 min ago and whose `strategy_version_seen` ≠ current version;
    resolves those alerts when the versions match.
  - `DeviceStatus(ctx, deviceID uuid.UUID) (Status, error)` with the fields of `DevicePolicyStatus` below.
  - Contract: `DevicePolicyStatus {push_enabled, policy {id,name}, source, source_group {id,name}|null,
    effective_settings, status: applied|pending|off, always_reachable, window: AccessWindow|null}`,
    `AccessWindow {id, opened_by, opened_at, ends_at, disconnect_on_close}`,
    `AccessWindowOpen {duration_minutes: 60|240|480|null, disconnect_on_close}`, `AccessWindowClose {disconnect}`;
    routes `GET /devices/{id}/policy` (all roles; Users scoped like `GET /devices/{id}` via
    `a.d.Devices.Get(ctx, id, scopeOf(user))`), `POST /devices/{id}/access-window`,
    `POST /devices/{id}/access-window/close` (owner, admin); alert kind enum gains `access_window_unconfirmed`;
    new 409 codes `window_open`, `push_off`, `always_reachable`; not approved → existing `bad_transition`.
  - The sweep runs every 30 s from `internal/app` next to the stats snapshotter, stopped on shutdown.

- [ ] **Step 1: Write the failing tests:** service tests for each error, both audits, `SweepExpired` (closes at
  the boundary, audits without actor, disconnects only when asked, opens the alert after 5 min of mismatch,
  resolves it on match), `TestDevicePolicyStatusScope` (a User granted the device reads it; not granted → 404),
  roles tests for the two writes, events test: opening a window emits `device.updated` for that device.
- [ ] **Step 2:** go gate → FAIL.
- [ ] **Step 3:** Contract, queries, service methods, handlers, routes, sweep wiring.
- [ ] **Step 4:** go gate → PASS; `npm run gen:api:check` and `typecheck` in `web/`.
- [ ] **Step 5:** Commit `feat(policies): access windows, device policy status, expiry sweep`.
- [ ] **Step 6 (Lead):** security review of Tasks 4-5 together: Claude `security-auditor` and Gemini High in
  parallel, read-only; findings ruled before Task 6 starts.

### Task 6: Web mocks for every new operation (t117, Codex Luna medium)

**Files:**
- Modify: `web/src/mocks/operations.ts`, `web/src/mocks/handlers.ts`, `web/src/mocks/db.ts`,
  `web/src/mocks/handlers.test.ts`, `web/src/mocks/userRole.test.ts`; Create: `web/src/mocks/routes/policies.ts`

**Interfaces:**
- Produces: mock implementations of every route from Tasks 3 and 5 following the contract (validation, 409s,
  role rules, inheritance through the mock groups, windows that expire on the mock clock), and
  `MockControls.setDeviceVersionSeen(deviceId: string, applied: boolean): void` for UI tests.

- [ ] **Step 1:** Failing `handlers.test.ts` cases per route and error; `userRole.test.ts` for User 403s and the
  scoped status read.
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement. **Step 4:** `npm test`, `typecheck`, `lint` → exit 0.
- [ ] **Step 5:** Commit `test(web): mock client policies and access windows`.

### Task 7: Client policies page and group picker (t118, Gemini Medium, designs within the spec)

**Files:**
- Create: `web/src/routes/_app/settings/policies.tsx`, `web/src/components/settings/policies-view.tsx` (+ test),
  `web/src/components/settings/policy-editor.tsx` (reuses the rows of `deployment-settings-card.tsx`)
- Modify: `web/src/components/settings/settings-index-view.tsx` (link), `web/src/components/groups/groups-view.tsx`
  and `group-dialogs.tsx` (policy picker), `web/e2e/policies.spec.ts` (new)

- [ ] **Step 1:** Failing Vitest: list, create, edit ("Not managed" or a value per catalog row, baseline pinned
  and required), the lockout confirmation copy exactly
  `Devices using this policy can only be reached through an access window or by someone at the device.`,
  delete blocked for Default and for a policy in use (409 message shown), owner-only push switch with its
  confirmation, group picker showing `Inherited: <policy> (from <group>)` or `Default`.
- [ ] **Step 2-4:** implement until `npm test`, `typecheck`, `lint`, `build`, `build:mock`, and
  `npx playwright test e2e/policies.spec.ts --global-timeout=900000 --reporter=line` pass.
- [ ] **Step 5:** Commit `feat(web): client policies page and group policy picker`.

### Task 8: Device panel status and window controls; Deployment note (t119, Gemini Medium)

**Files:**
- Modify: `web/src/components/devices/device-panel.tsx` (or a new `device-policy-section.tsx` it renders, + test),
  `web/src/components/settings/deployment-download-card.tsx` (note), `web/e2e/device-panel.spec.ts` (or new spec)

- [ ] **Step 1:** Failing Vitest: `Policy: <name> (from group <group>) · Applied` / `Pending`; owners/admins see
  **Allow access** with 1 h / 4 h / 8 h / until switched off and "also disconnect when it closes"; an open window
  shows `Reachable until HH:MM` and Close now with the disconnect checkbox; `Closing…` while closed but not
  applied; `Always reachable (policy allows password logins)` replaces the control; Users see status only;
  push off shows the policy as off; live `device.updated` refetches the status. Deployment card note while push
  is on: `Settings managed by a policy override this script's values within about 15 seconds.`
- [ ] **Step 2-4:** implement until the web checks and the touched Playwright specs pass.
- [ ] **Step 5:** Commit `feat(web): device policy status and access windows`.

### Task 9: Live flow and docs (t120, Codex Luna medium)

**Files:**
- Modify: `web/e2e-live/flow.spec.ts` (or new `policies.spec.ts` there), `README.md` (a "Client policies" section:
  what is pushed, the switch, windows, that devices keep settings after push is switched off), `AGENTS.md`
  (where-things-are row for `internal/policies`)

- [ ] **Step 1:** Failing live spec: owner switches push on, opens a window on a simulated device, the panel
  reaches `Applied` (rdsim replays `modified_at`), closes the window, status returns to the baseline.
- [ ] **Step 2-4:** `npm run e2e:live` passes. **Step 5:** Commit `test(e2e-live): client policies flow; docs`.

### Task 10: Alpha release and lab gate (t121, Codex Luna low + Lead + user)

- [ ] **Step 1 (Codex):** `CHANGELOG.md` `## [1.6.0-alpha.1]` with an "Added" entry for client policies and
  access windows (marked as a preview); `deploy/.env.example` unchanged (stays on the stable version).
- [ ] **Step 2 (Lead):** release gate on `feature/client-policies`; tag `v1.6.0-alpha.1`; publish with
  `scripts/release-image.sh 1.6.0-alpha.1` (no `:latest`); manifest lists amd64 and arm64.
- [ ] **Step 3 (user):** lab gate on a real 1.5.0 client: a policy turns file transfer off and the client shows
  it; a window lets the fleet password connect; after closing, the connection is refused.
