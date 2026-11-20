# Automatic grouping by device name, Auto sort, and more mass actions (design)

Status: approved in conversation (user, 2026-10-22), sections 1-3. Author: Project Lead 9. Ships as **1.8.0** on
`main` (the macOS deployment work stays parked after it).

## Goal
Organisations name devices by a scheme, e.g. `w-sf-it-{serial}` (OS-Org-Dept-Serial). When a device is first approved,
rdadmin puts it into a group by matching its name against patterns the admin attaches to groups, like dynamic groups
in Windows. An owner can also re-sort the whole approved fleet by the rules (**Auto sort all**). The Devices page's mass
actions gain **Move to group** and **Delete**. Everything updates live.

Decisions (user): name matching with wildcards, patterns attached to groups; only at first approval, plus the
owner's Auto sort all, which overrides manual placement; on conflict, a single approval asks (resolution window), mass
approval and Auto sort all flag the device; the flag is clickable and opens the same window; rules are applied on
the server.

## 1. Rules and matching
- **Table `group_rules`** (migration 00017): `id uuid`, `group_id` → `device_groups` `ON DELETE CASCADE`, `pattern text`,
  `created_at`, `created_by` → `users` `ON DELETE SET NULL`; unique (`group_id`, `lower(pattern)`). At most 20 patterns
  per group. Deleting a group deletes its patterns.
- **Pattern syntax:** 1-128 characters from `A-Z a-z 0-9 - _ . * ?`; `*` = any run of characters (also none), `?` =
  exactly one character. Case-insensitive. The pattern must match the **whole** name (`w-*-it-*` matches
  `w-sf-it-5CG1234`, not `xw-sf-it-1`; `*it*` matches anywhere). No regular expressions. Matching is a linear-time
  wildcard match (no backtracking blow-up).
- **Name matched:** the device's `hostname` (reported by the client's sysinfo). Not the alias (admin-set; a new device
  has none). An empty hostname matches nothing.
- **Decision:** the set of groups with at least one matching pattern. None → no group; exactly one → that group; two
  or more → **conflict**. There is no ranking, specificity or tree-depth rule.
- **Conflict flag:** a new device alert kind `group_conflict` (`device_alerts`, `details` = `{"group_ids": [...]}`), one
  open per device like every alert kind. It shows wherever alerts show (device panel, Needs attention) and is
  clickable: it opens the **resolution window** (pick one of the matching groups, or keep the device where it is).
  Any change of the device's group (the window, a manual move, a mass move, Auto sort all) resolves an open
  `group_conflict` alert in the same transaction; "keep where it is" resolves it through the existing resolve endpoint.

## 2. When rules run, and who may do what
- **Single approval** (`POST /devices/{id}/approve`, from the UI or `scripts/approve-device.ps1`): rules run only when
  the device goes from pending or rejected to approved **and** has no group. A group set before approval always wins;
  restoring an archived device does not run them. One match: approved and placed in the same transaction (the
  `device.approved` audit entry records `group_id` and the matching `pattern`). Conflict: approved, no group, flag
  raised; the web app sees the alert in the response and opens the resolution window at once. Approval never fails
  because of rules.
- **Mass approval** (existing action bar): the same single-approval requests, so the same rules per device; the UI does
  **not** open the window during a mass approval: conflicts stay flagged. The result reports approved, placed,
  flagged and refused counts.
- **Mass move** and **mass delete** (new in the action bar): one single-device request per device (`PATCH
  /devices/{id}` with `group_id`, `DELETE /devices/{id}`), exactly as by hand, run a few at a time like the existing
  bulk actions, with per-device results. Move warns that devices take the target group's client policy; delete warns
  that session history is removed too and that devices with an open access window are refused.
- **Auto sort all** (owner only): applies to **approved** devices. One match → moved there, overriding a manual
  placement (no-op if already there); no match → left where it is; conflict → not moved, flagged (also when its current group is one of the
  matches: the rules are ambiguous for it either way). First a dry run
  (`POST /devices/auto-sort/preview`) feeds the warning: devices that will move (from → to), conflicts, the unchanged
  count. The run (`POST /devices/auto-sort`) recomputes in one transaction and returns what it did. Pending devices are
  untouched (they sort at approval).
- **Roles:** rules (list, add, remove, preview), mass approve, mass move, mass delete: owner and admin (as their
  single-device versions today). Auto sort all (preview and run): **owner only**. Users: none of it (403).
- **Audit:** every device change is its own entry as if done by hand, with a reason: `device.approved` (+ `group_id`,
  `pattern`), `device.updated` (group change; `details.reason` = `auto_sort` or `conflict_resolved`), `device.deleted`.
  Rules: `group.rule_added`, `group.rule_removed` (group id and pattern). A run adds one summary entry
  `devices.auto_sorted` (`moved`, `conflicts`, `unchanged`). Every new action gets a log-export sentence and category
  (the log export coverage test enforces it).

## 3. API, screens, live updates, tests
- **API** (contract first, exact YAML in the backend task):
  - `GET /group-rules` → every pattern with its group (owner, admin).
  - `POST /groups/{id}/rules` `{pattern}` → 201 the rule; 400 naming `pattern` (syntax, length, the 20 limit); 409
    `pattern_taken` (new error code) for a duplicate pattern in that group. `DELETE /groups/{id}/rules/{rule_id}` → 204.
  - `POST /groups/{id}/rules/preview` `{pattern}` → the approved devices the pattern would match and those it would put
    in conflict (with the groups); not saved, not audited.
  - `POST /devices/auto-sort/preview` and `POST /devices/auto-sort` (owner) → `{moves: [{device, from_group,
    to_group}], conflicts: [{device, groups}], unchanged: n}`.
  - `Alert` gains kind `group_conflict` and a `groups` field (`[{id, name}]`, empty for other kinds).
  - `POST /devices/{id}/approve` is unchanged in shape; its response shows the new group or the alert.
- **Live updates:** device moves and alerts already send `device.updated` (device lists, groups, dashboard refresh).
  New event **`group_rules.updated`** (trigger on `group_rules` → `NOTIFY rdadmin_events`, listener mapping,
  `LiveEvent`, events tests, per AGENTS.md) refreshes the rules on open Groups pages; Users never receive it.
- **Screens** (Gemini designs within this brief): Groups page: per group an "Auto-Sort Rules" area (patterns, an add
  field with the live preview "matches 12 devices, 1 conflict", remove); an owner-only red **Auto Sort All** button
  opening a warning with the dry-run numbers and list, enabled only after ticking "I understand these devices will
  move and may get a different client policy". Devices page action bar: **Move to Group** (the existing group picker)
  and **Delete**, each with its warning. The `group_conflict` alert is a button that opens the resolution window; a
  single approval ending in a conflict opens the same window.
- **Tests:** Go: the matcher (wildcards, case, whole-name, invalid characters, a pathological pattern stays fast),
  approval (0/1/many matches, existing group kept, restore does not sort, conflict flag, transaction rollback), alert
  resolution on any group change, Auto sort all (preview equals run on unchanged data, override, no-match left alone,
  conflicts flagged, owner only), roles, audit entries and their log-export sentences, the live event; a backend-gate
  step (rule → approve → device in the group). Web: mocks for every new operation, Vitest for the screens; a
  Playwright spec (rules, preview, Auto sort all warning, resolution window, Move to Group, Delete) by a Claude worker.

## Rollout
Backend task (Codex): migration, matcher, approval hook, alert kind, rules API, auto-sort API, audit + log-export
sentences, live event, mocks, gate step. Security/code review of the backend (Claude `security-auditor`: authorization,
the owner-only run, transaction scope). UI task (Gemini): Groups page rules + Auto Sort All, resolution window, action bar
Move to Group + Delete. Playwright spec (Claude worker). Docs + release 1.8.0 (README "Automatic grouping", CHANGELOG).

## Out of scope
Matching on OS, username or other fields (possible later: the matcher takes a field name); regular expressions;
ordering or priority between rules; sorting pending devices before approval; server-side bulk endpoints for
approve/move/delete; undo for Auto sort all (the audit log records every move).
