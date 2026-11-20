# Client policies and access windows: design

Status: approved by the user on 2026-10-17 (Project Lead 8). Brainstormed with the user on
2026-10-16/17; every section below was approved in conversation.

## Goal

rdadmin keeps stock RustDesk 1.5.0 clients on the settings an admin chose, **per device group**, and
lets owners and admins open **time-limited access windows** on a single device (just-in-time access).
Everything travels in the heartbeat reply the client already polls every 15 s; no password or other
secret is sent.

## What the user said (the brief)

- Different rules per group; temporary access (JiT).
- Users reach the devices granted to them from any computer with RustDesk; what matters is the
  person's grants, not the controlling machine. Owners and admins switch a device's reachability on and
  off as needed; this adds to the existing grants.
- JiT must not send passwords. (The user first proposed sending a hashed password; the stock client
  cannot accept one, see Facts.)
- Assumptions the user confirmed: "reachable" means password logins are allowed; no allow-list of
  controller machines in this version; windows can be timed or open until switched off; only catalog
  settings are pushed, never server addresses or the key.

## Facts this rests on

From `docs/orchestration/specs/2026-10-16-client-capabilities-research.md` (t109), spot-checked by the
Lead in `a local RustDesk 1.5.0 checkout`:

- The heartbeat reply may carry `strategy.config_options` (`{key: value}`) and `modified_at`; the
  client writes every pair into its options **without an allow-list** (`src/hbbs_http/sync.rs:294-308`);
  an empty value removes the option when it has no built-in default. The client stores the reply's
  `modified_at` and sends it back as `modified_at` in its next heartbeat (`sync.rs:243-266`).
  Idle heartbeat interval: 15 s (`sync.rs:18`).
- The permanent password and the unlock PIN are not options; the heartbeat cannot change them. A hashed
  preset password exists only in a `custom.txt` signed with RustDesk's own key
  (`src/common.rs:2463-2468`), so rdadmin cannot use it. Password changes stay with the deployment
  script (`--password`).
- Access is enforced **on the device** for every incoming connection, however it arrives:
  `approve-mode` (`password`, `click`, anything else = both; `libs/hbb_common/src/password_security.rs:77-86`)
  and `verification-method`. rdadmin is not in the connection path (hbbs/hbbr are stock).
- rdadmin already has the wire types (`internal/clientapi/wire/device.go`: `HeartbeatResponse.ModifiedAt`,
  `Strategy.ConfigOptions`) and Deployment Assist's settings catalog (`internal/deploy/catalog.json`: 11
  settings with labels, help and value labels).

## Concepts

### Policies
- A **policy** is a named set of catalog settings. Each catalog setting is either **set** to one of its
  catalog values or **not managed** (not sent; devices keep what they have).
- **Access baseline:** every policy must set `approve-mode` and `verification-method`. This is the
  device's normal access state and what a closed window returns to.
- One **Default** policy always exists (cannot be deleted; name fixed). It applies to devices without a
  group and to groups that resolve to no policy.
- Each device group has an optional policy. A group without one **inherits from its nearest parent
  group** that has one (`device_groups.parent_id`), else Default.
- Pushable keys are exactly the catalog keys (`internal/deploy/catalog.json`); anything else (server
  addresses, `key`, `api-server`, `stop-service`, whitelists, ...) is refused by the API and filtered
  again when the heartbeat reply is built.
- Initial Default policy: `approve-mode = password-click`, `verification-method = use-both-passwords`,
  nothing else managed (matches RustDesk's own defaults, so switching push on changes nothing until an
  admin tightens a policy).

### Access windows
- Owners and admins open a window on **one device** for 60, 240 or 480 minutes, or until switched off.
  Users do not open windows; they use whatever is open on their granted devices.
- While a window is open, the device's effective `approve-mode` is `password-click` and
  `verification-method` is `use-both-passwords` (the fleet password works unattended); every other
  setting stays as the policy says.
- A window closes when it expires or when an owner or admin closes it. rdadmin then pushes the policy's
  baseline again. Closing optionally ends the device's open sessions (checkbox, default off) through
  the existing Session Kill mechanism (`disconnect` in the heartbeat reply).
- A device whose policy baseline already allows password logins (`approve-mode` ∈ {`password`,
  `password-click`} and `verification-method` ∈ {`use-permanent-password`, `use-both-passwords`}) is
  **always reachable**; the panel says so and windows are not offered (409 if requested).
- At most one open window per device.

### Fleet switch
- "Push policies to devices": **off by default**, owner only. Switching on shows a confirmation that
  summarises what will be pushed. Switching off warns that devices **keep** the last settings they
  received (the client cannot be told to forget them).

## Data (migration `00013`)

- `client_policies`: `id uuid`, `name text UNIQUE`, `settings jsonb` (`{key: value}`, set keys only),
  `is_default bool` (unique partial index: one default), `created_at`, `updated_at`, `updated_by`.
  Seeded with the Default policy.
- `device_groups.policy_id uuid NULL REFERENCES client_policies(id)` (deleting a policy that a group
  uses is refused by the API with 409, not by cascade).
- `access_windows`: `id`, `device_id`, `opened_by`, `opened_at`, `ends_at NULL` (NULL = until switched
  off), `closed_at NULL`, `closed_by NULL` (NULL with `closed_at` set = expired), `close_reason`
  (`manual`, `expired`), `disconnect_on_close bool`. Partial unique index: one row per device with
  `closed_at IS NULL`.
- Fleet switch: a new single-row table `client_policy_settings` (`id smallint PRIMARY KEY CHECK (id = 1)`,
  `push_enabled bool NOT NULL DEFAULT false`, `updated_at`, `updated_by`), seeded with one row.
- `devices.strategy_version_seen bigint NULL`: the last `modified_at` the device reported; written only
  when it changes.

## Heartbeat behaviour (`internal/clientapi`)

Only for **approved** devices and only while the fleet switch is on; otherwise the reply is unchanged
from today (no `strategy`, no `modified_at`).

1. **Effective settings** = the device's policy (group → parent groups → Default) with the open,
   unexpired window's override on top. Expiry is decided here from `ends_at`, so enforcement never
   waits for a background job.
2. Filter to catalog keys (second guard).
3. **Version** = the first 8 bytes of SHA-256 over the canonical JSON of the effective map (keys
   sorted), as a positive non-zero `int64`. It changes exactly when the effective settings change.
4. Reply with `modified_at = version` and `strategy.config_options = effective settings` on **every**
   heartbeat, so local drift is corrected within about 15 s.
5. Store the client's reported `modified_at` in `devices.strategy_version_seen` when it changed.
   **Applied** = reported version equals the current version; otherwise **Pending**.

The device, its group chain, the policy and the open window come from **one** query (recursive CTE),
because every device calls this every 15 s. A small background sweep marks expired windows closed
(`close_reason = expired`, `closed_by` NULL) for the audit log and live events; it is not needed for
enforcement.

**Unconfirmed close:** if a window is closed and the device has not reported the post-close version
5 minutes later, the device gets an alert (new alert kind `access_window_unconfirmed`, shown with the
existing device alerts) that resolves itself when the device reports the current version.

## Admin API (contract first: `internal/adminapi/openapi.yaml`)

Owners and admins unless noted; Users get 403 `forbidden` on every write. The task files carry the
exact YAML; shapes here are the design.

- `GET /policies` (list), `POST /policies` (`{name, settings}`), `GET/PATCH/DELETE /policies/{id}`.
  Validation: names unique (409 `conflict`); every key in the catalog and every value in its catalog
  values (400 `bad_request` with the field); `approve-mode` and `verification-method` required.
  Default: no DELETE (409), name not editable. DELETE of a policy used by a group: 409.
- `GET /settings/policy-push` (owners and admins) → `{enabled, updated_at, updated_by}`;
  `PUT /settings/policy-push` (**owner only**) `{enabled}`.
- `PATCH /groups/{id}` accepts `policy_id` (uuid or null). `Group` gains `policy_id` and read-only
  `effective_policy_id` (inheritance resolved).
- `GET /devices/{id}/policy` (owners, admins, and Users for their granted devices) →
  `{push_enabled, policy: {id, name}, source: group|parent_group|default, source_group: {id, name}|null,
  effective_settings: {key: value}, status: applied|pending|off, always_reachable,
  window: {id, opened_by, opened_at, ends_at, disconnect_on_close}|null}`.
- `POST /devices/{id}/access-window` `{duration_minutes: 60|240|480|null, disconnect_on_close}` → the
  window. 409 when a window is open, when push is off, when the device is always reachable, or when the
  device is not approved.
- `POST /devices/{id}/access-window/close` `{disconnect}` → 204. 404 when no window is open.
- Live events: opening, closing or expiring a window and Applied↔Pending changes emit `device.updated`
  for that device (Users with grants receive it). No new event type.
- Audit (same transaction): `policy.created`, `policy.updated`, `policy.deleted`, `group.updated`
  (details include the policy change), `policy_push.enabled`, `policy_push.disabled`,
  `access_window.opened`, `access_window.closed` (details: reason `manual`|`expired`, disconnect). Expiry
  is recorded with no actor (system).
- `roles_test.go` gains every new route (`add("forbidden", ...)` for Users on writes; the Users read of
  `GET /devices/{id}/policy` limited to granted devices).

## UI (`web/`; Gemini designs the visuals within these limits)

- **Settings → Client policies** (new page, owners and admins): policy list; editor reusing Deployment
  Assist's setting rows (labels, help, value labels from the catalog) where each setting is "Not
  managed" or a value; the access baseline pinned at the top. Saving a baseline that refuses password
  logins asks for confirmation: "Devices using this policy can only be reached through an access
  window or by someone at the device." The owner's push switch with its confirmation lives here.
- **Groups page:** a policy picker per group; unset shows "Inherited: <policy> (from <group>)" or
  "Default".
- **Device panel:** "Policy: <name> (from group <group>) · Applied/Pending"; owners and admins get
  **Allow access** (1 h / 4 h / 8 h / until switched off, "also disconnect when it closes") or
  "Reachable until 15:30 · Close now [ ] also disconnect", and "Closing…" until confirmed; Users see the
  status read-only. "Always reachable (policy allows password logins)" replaces the control when it
  applies.
- **Deployment page:** a note that settings managed by a policy override the script's values within
  about 15 s while push is on.

## Risks

- **Self-lockout:** a baseline that refuses password logins makes devices reachable only through a
  window or locally; the confirmation above says so.
- **Window stuck open** if the device loses rdadmin while hbbs still connects it: "Closing…" plus the
  `access_window_unconfirmed` alert; short windows by default.
- **rdadmin compromise:** only catalog settings can be pushed (API validation plus the heartbeat
  filter); server addresses and the key are never sent, so devices cannot be redirected or cut off.
- **Local changes / deployment scripts:** managed settings are re-pushed every heartbeat; the unlock
  PIN keeps local users out of the settings.
- **Client versions:** tested with 1.5.0 only; other versions that ignore the strategy show as Pending.

## Testing

- Go: resolver unit tests (inheritance, window override, expiry at the boundary, allow-list filter,
  version stability and change); store tests (`internal/store/store_test.go` for new tables); API tests
  incl. roles; a backend gate in `internal/e2e` where `rdsim` devices pick up a strategy, report the
  version (Applied), and a window opens and expires (`internal/sim` reports `modified_at`).
- Web: Vitest; mock API (`web/src/mocks/**`: operations, handlers, routes, handlers.test,
  userRole.test); Playwright flows; an `e2e:live` flow.
- Security: Claude `security-auditor` and Gemini High in parallel (access-control change).
- **Lab gate** with a real 1.5.0 client: a policy turns file transfer off and the client shows it; a
  window lets the fleet password connect; after closing, the connection is refused.

## Build order (each a task or a small group of tasks)

0. **Real-client check (throwaway, before anything is built):** a dev build answers every heartbeat
   with a fixed `strategy` (`enable-file-transfer: N`) and `modified_at`; the user confirms on a real
   1.5.0 client that the setting is applied and the next heartbeat reports the same `modified_at`. If
   it fails, stop and revisit this design.
1. Contract, migration `00013`, queries, and the resolver package (`internal/policies`), with tests.
2. Heartbeat enforcement, the windows API, the expiry sweep, the unconfirmed-close alert, audit, live
   events; then both security reviews.
3. Web: Client policies page and the group picker.
4. Web: device panel status and window controls; the Deployment page note.
5. `e2e:live` flow, lab gate, README section, release **1.6.0**.

## Out of scope

- Allow-listing controller machines (`id-whitelist`, `whitelist`), per-device setting overrides, tag-
  based policies.
- Password or PIN changes through the heartbeat (impossible with the stock client); password rotation
  stays with deployment scripts.
- Users requesting windows (approval flow), scheduled windows.

## Release: an alpha on a feature branch (user, 2026-10-17)

- All work happens on the long-lived branch **`feature/client-policies`** (created from main at
  0982092). Each task branches from it and its PR targets it; main is merged into it regularly.
- Pre-releases are tagged on that branch as **`1.6.0-alpha.N`** and published with
  `scripts/release-image.sh` (a pre-release never moves `:latest`). The release gate runs on the
  tagged commit as for any release.
- main stays stable and can ship 1.5.x fixes at any time.
- When the user is confident, `feature/client-policies` merges into main and is released as **1.6.0**.
- Note: `.github/workflows/release-image.yml` refuses tags that are not on main; alphas are published
  manually with the script (as every release is until GitHub Actions minutes return).
