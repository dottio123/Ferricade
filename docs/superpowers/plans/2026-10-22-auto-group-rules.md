# Automatic Grouping Implementation Plan

> **For agentic workers:** this plan becomes task files under `docs/orchestration/tasks/` (t144 onward), dispatched by
> the Project Lead per `docs/orchestration/ORCHESTRATION.md`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** sort devices into groups by hostname wildcard patterns at first approval, let the owner re-sort the approved
fleet (Auto sort all), flag ambiguous matches with a clickable `group_conflict` alert, and add Move to Group and Delete
to the Devices action bar.

**Architecture:** a pure matcher package (`internal/grouprules`) decides the candidate groups for a hostname; the
devices service calls it inside the approval transaction; a rules service owns the `group_rules` table, the
previews and the Auto sort run; the admin API exposes them; the web UI adds the rules area, the red button, the
resolution window and two bulk actions that reuse single-device requests.

**Tech Stack:** Go (pgx, sqlc, goose, chi, testify), Postgres 16; React 19, TanStack Router/Query, openapi-fetch, Vitest,
Playwright.

**Spec:** `docs/superpowers/specs/2026-10-22-auto-group-rules-design.md`.

## Global Constraints
- Base `main` (52755ed = v1.7.0 or later); every PR targets `main`; ships as **1.8.0**. Next migration: **00017**.
- Pattern: 1-128 chars from `A-Z a-z 0-9 - _ . * ?`; `*` any run (also empty), `?` exactly one char; whole-name,
  case-insensitive; matched against `devices.hostname` only; empty hostname matches nothing; ≤ 20 patterns per group.
- Conflict = 2+ matching groups; never ranked. Alert kind `group_conflict`, `details = {"group_ids": [...]}`.
- Rules run on approve only from `pending`/`rejected` and only when `group_id IS NULL`; never on restore.
- Any group change of a device resolves its open `group_conflict` alert in the same transaction.
- Roles: rules + previews + mass actions owner/admin; Auto sort preview/run **owner only**; Users 403.
- New error code `pattern_taken` (409). New live event `group_rules.updated` (staff only).
- Audit actions: `group.rule_added`, `group.rule_removed`, `devices.auto_sorted`; `device.approved` gains `group_id` +
  `pattern`; `device.updated` gains `details.reason` (`auto_sort` | `conflict_resolved`). Each new action has a
  log-export sentence and category (`TestEveryAuditActionHasSentenceAndCategory`).

## Review Focus
1. **A device is renamed after approval:** it must not move by itself (rules run only at approval or Auto sort all).
   → t144 `TestRenameAfterApprovalDoesNotMove`.
2. **A matching group is deleted while a `group_conflict` alert still names it:** the alert's `groups` lists only
   existing groups; choosing a deleted group answers 400 naming `group_id`, never a 500. → t144
   `TestConflictAlertSkipsDeletedGroup`.
3. **A pathological pattern** (`*a*a*a*a*a*a*a*a*b` against a 128-char `aaaa…` hostname): matching stays linear.
   → t144 `TestMatchPathologicalIsFast` (< 10 ms for 10,000 calls).
4. **Auto sort all on a large fleet** (5,000 approved devices, 50 rules): completes in one transaction without
   timing out the request. → t145 `TestAutoSortLargeFleet` (< 15 s in the gate container).
5. **Two owners press Auto sort all at once**, or a device is approved during a run: runs serialize
   (`pg_advisory_xact_lock`), no device is double-audited or left half-moved. → t145 `TestAutoSortConcurrentRunsSerialize`.

---

### Task 1 (t144, Codex Sol high): matcher, rules table, approval hook, conflict alert, rules API, live event
**Files:** create `internal/store/migrations/00017_group_rules.sql`, `internal/store/queries/grouprules.sql`,
`internal/grouprules/{match.go,service.go}` (+ tests); modify `internal/devices/service.go` (`Transition`, `Update`,
`Alert`), `internal/devices/groups.go` (if group deletion needs it), `internal/adminapi/{openapi.yaml,router.go,
grouprules.go,devices.go,errors.go}` (+ tests, `roles_test.go`), `internal/events/listen.go` (+ tests),
`internal/logexport/describe.go` (+ test table), `internal/e2e/gate_test.go`, `web/src/api/schema.d.ts`, `web/src/mocks/**`.
**Interfaces (produces):**
- `grouprules.Valid(pattern string) error`; `grouprules.Match(pattern, name string) bool`;
  `grouprules.Candidates(rules []Rule, hostname string) []uuid.UUID` (distinct group ids, sorted);
  `type Rule struct{ ID, GroupID uuid.UUID; Pattern string }`.
- `grouprules.Service{Pool}`: `List(ctx) ([]RuleView, error)`, `Add(ctx, a devices.Actor, groupID uuid.UUID, pattern string)
  (RuleView, error)`, `Remove(ctx, a, groupID, ruleID uuid.UUID) error`, `Preview(ctx, groupID uuid.UUID, pattern string)
  (RulePreview, error)`.
- Migration: `group_rules` per spec §1; `device_alerts.kind` check gains `group_conflict`; trigger on `group_rules`
  insert/delete → `NOTIFY rdadmin_events` `{"kind":"group_rules","op":"updated"}`; listener maps it to
  `group_rules.updated`, staff only.
- API: `GET /group-rules`, `POST /groups/{id}/rules`, `DELETE /groups/{id}/rules/{rule_id}`,
  `POST /groups/{id}/rules/preview`; `Alert.kind` + `group_conflict`, `Alert.groups`.
- [ ] Tests first (watch each fail): matcher table (`w-*-it-*` vs `w-sf-it-5CG1234` true, vs `xw-sf-it-1` false, `?`,
  case, empty hostname false, invalid chars rejected by `Valid`, 129 chars rejected), `TestMatchPathologicalIsFast`;
  approval: 0/1/2 matches, existing group kept, restore does not sort, rejected→approved sorts, conflict raises one
  alert, audit `device.approved` has `group_id` + `pattern`; `TestRenameAfterApprovalDoesNotMove`;
  `TestConflictAlertSkipsDeletedGroup`; `Update` with a new group resolves `group_conflict` and audits
  `device.updated` with `reason: conflict_resolved`; the existing `POST /devices/{id}/alerts/{alert_id}/resolve` resolves
  a `group_conflict` alert ("keep where it is") without moving the device; rules API roles,
  validation, `pattern_taken`, 20 limit, preview counts; live event delivered to staff and not to Users; log-export
  sentences for the new actions; gate step (add `w-*-it-*` to a group, enroll `w-sf-it-1`, approve → in that group).
- [ ] Implement; Go gate → exit 0; web gen:api:check, typecheck, lint, `npm test` → exit 0; commit.

### Task 2 (t145, Codex Sol high): Auto sort all
**Files:** `internal/grouprules/autosort.go` (+ test), `internal/adminapi/grouprules.go`, `openapi.yaml`, `router.go`
(owner group), tests, `internal/logexport/describe.go`, `web/src/api/schema.d.ts`, `web/src/mocks/**`.
**Interfaces:** consumes `Candidates`, `Rule`; produces `Service.AutoSortPreview(ctx) (AutoSortResult, error)`,
`Service.AutoSort(ctx, a devices.Actor) (AutoSortResult, error)`; `AutoSortResult{Moves []Move; Conflicts []Conflict;
Unchanged int}`; API `POST /devices/auto-sort/preview`, `POST /devices/auto-sort` (owner).
- [ ] Tests first: preview equals run on unchanged data; override of a manual placement; no match left alone; conflict
  (also when the current group is a match) not moved and flagged once (no duplicate alert on a second run); pending
  untouched; per-device `device.updated` (`reason: auto_sort`) + one `devices.auto_sorted` summary; admin 403;
  `TestAutoSortLargeFleet`; `TestAutoSortConcurrentRunsSerialize`.
- [ ] Implement (one transaction, `pg_advisory_xact_lock`); Go gate → exit 0; web checks → exit 0; commit.

### Task 3 (t146, Claude `security-auditor`): read-only review of t144 + t145
Focus: authorization (owner-only run, Users), transaction scope (approval + placement + alert atomic), alert
resolution on every group-change path, pattern validation and matcher cost, audit completeness, live event scoping,
the group-deletion path. Fixes go to a Round.

### Task 4 (t147, Gemini Medium): Groups page rules + Auto Sort All, resolution window, Move to Group + Delete
**Files:** `web/src/components/groups/**` (rules area, red button + warning dialog), a resolution dialog component
(`web/src/components/devices/group-conflict-dialog.tsx` + test), `device-panel.tsx`/Needs-attention alert rendering
(clickable `group_conflict`), `approve-reject-actions.tsx` (open the dialog after a single approval that returned the
alert), `bulk-action-bar.tsx` (+ tests) for Move to Group and Delete via `runWithConcurrency`, query keys, live-event
handling of `group_rules.updated`. No Playwright for Gemini.
- [ ] Vitest: rules add/remove/preview, `pattern_taken` shown at the field; Auto Sort All disabled until the tick, shows
  the preview numbers, owner only; dialog opens after a single approval with a conflict and from the alert; mass
  approval does not open it and its result reports how many were placed and how many flagged; Move to Group warning text and per-device results; Delete warning and refusal report.
- [ ] typecheck, lint, `npm test`, build, build:mock → exit 0; commit.

### Task 5 (t148, Claude worker): Playwright spec
`web/e2e/auto-group.spec.ts`: rule add with preview, single approval → placed, conflict → window, flag click → window,
Auto Sort All warning (owner) and absence (admin), Move to Group, Delete; axe light/dark on the Groups page. 3 clean runs.

### Task 6 (t149, Claude worker): docs and release 1.8.0
README "Automatic grouping" (patterns, conflicts, Auto sort all and its override, mass actions), CHANGELOG 1.8.0,
`deploy/.env.example` 1.8.0; Lead runs the release gate, tags, publishes.
