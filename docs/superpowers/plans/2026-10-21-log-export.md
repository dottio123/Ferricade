# Log Export Implementation Plan

> **For agentic workers:** this plan becomes task files under `docs/orchestration/tasks/` (t138 onward), dispatched by
> the Project Lead per `docs/orchestration/ORCHESTRATION.md`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** export rdadmin's audit trail and remote sessions as readable, ECS-style JSON events to a rotating JSON-lines
file and to syslog (RFC 5424 over TCP/TLS), for Zabbix and SIEMs.

**Architecture:** database triggers fill a `log_export_outbox` in the same transaction as each audit row and each
session start/end; an exporter loop in `internal/logexport` builds one record per outbox row and delivers it per
enabled output, marking `<output>_done_at`; owner-only settings and per-output status through the admin API.

**Tech Stack:** Go (pgx, sqlc, goose, chi, testify, `crypto/tls`), Postgres 16; React 19 + TanStack (settings page).

**Spec:** `docs/superpowers/specs/2026-10-21-log-export-design.md` (research:
`docs/orchestration/specs/2026-10-21-log-export-research.md`).

## Global Constraints
- Branch base `main` (af26340 = v1.6.0 or later); every PR targets `main`; ships as **1.7.0**.
- Next migration number: **00016** (main has 00001-00015).
- Outputs off by default; enabling an output starts at now (existing outbox rows marked done for it).
- Delivery: every 2 s, ≤ 500 rows per output per tick, order by outbox `id`, backoff up to 1 min, at-least-once.
- Outbox cleanup: rows done by every enabled output, and every row older than 7 days.
- File: `/var/log/rdadmin/events.jsonl`, rotate at 10 MB to `.1`…, keep 10, mode `0640`.
- Syslog: RFC 5424, TCP, octet counting (RFC 6587), `APP-NAME rdadmin`, `MSGID` = `event.action`, `HOSTNAME` = host of
  `PUBLIC_URL`, severity 4 (warning) for `outcome=failure` else 5 (notice), facility default `local0`, default port 6514
  with TLS / 514 without, TLS ≥ 1.2, system roots + optional `ca_pem` (≤ 64 KB), host name verified; format `json` |
  `text`.
- Only the owner changes settings (`PUT`, `POST …/test`); admins read; Users 403. `PUT` audited
  `settings.log_export_updated` with the changed field names (never the CA body).
- Events never contain secrets. `observer.version` = `runtime/debug.ReadBuildInfo().Main.Version`.
- The image runs as `nonroot` (uid 65532): the README tells operators to `mkdir logs && chown 65532:65532 logs`.

## Review Focus
1. **The log directory is not writable** (bind mount owned by the host user): the file output must report the exact
   error in its status and keep the backlog, never crash or drop events. → t138 test `TestFileOutputUnwritableKeepsBacklog`.
2. **A new audit action added later has no sentence/category:** a test must fail. → t138 test
   `TestEveryAuditActionHasSentenceAndCategory` (actions collected from the code's audit calls list).
3. **Syslog collector down for longer than the backoff, then back:** everything since is delivered in order, once
   (duplicates allowed only across a crash). → t139 test `TestSyslogOutageThenRecovery`.
4. **A huge burst (e.g. 10,000 audit rows from a bulk action):** delivered in 500-row batches without blocking the
   request that wrote them. → t138 test `TestExporterDrainsBurstInBatches`.
5. **TLS to a collector with a private CA and a wrong host name:** refused with a clear error, never sent in clear.
   → t139 test `TestSyslogTLSHostMismatchRefused`.

---

### Task 1 (t138, Codex Sol high): outbox, record, file output, settings API
**Files:** create `internal/store/migrations/00016_log_export.sql`, `internal/store/queries/logexport.sql`,
`internal/logexport/{record.go,describe.go,exporter.go,file.go,service.go}` (+ tests); modify `internal/app/app.go`
(start the exporter like the stats snapshotter), `internal/adminapi/{openapi.yaml,router.go,logexport.go}` (+ tests,
roles_test entries), `deploy/compose.yml` and `compose.dev.yml` (`./logs:/var/log/rdadmin`), `internal/e2e/gate_test.go`,
`web/src/api/schema.d.ts`, `web/src/mocks/**` (the three operations).
**Interfaces (produces):**
- Migration: `log_export_settings` (single row `id boolean = true`: `file_enabled`, `syslog_enabled`, `syslog_host`,
  `syslog_port`, `syslog_tls`, `syslog_ca_pem`, `syslog_facility`, `syslog_format`, `updated_at`, `updated_by`);
  `log_export_outbox` (`id bigserial`, `source text CHECK (source IN ('audit','session'))`, `ref_id uuid`,
  `phase text CHECK (phase IN ('start','end'))` null for audit, `created_at`, `file_done_at`, `syslog_done_at`, index on
  `id WHERE file_done_at IS NULL` and on `id WHERE syslog_done_at IS NULL`); triggers on `audit_events` INSERT and
  `remote_sessions` INSERT / UPDATE when `ended_at` goes from NULL to a value.
- `logexport.Record` (struct marshalling to the spec's JSON), `logexport.Build(ctx, q *db.Queries, row db.LogExportOutbox,
  host string) (Record, error)`, `logexport.Sentence(action string, ev AuditView) string`,
  `logexport.Category(action string) string`.
- `type Output interface { Name() string; Deliver(ctx context.Context, recs []Record) error }`; `logexport.FileOutput`.
- `logexport.Service{Pool, Now}` with `Settings(ctx)`, `Update(ctx, actor devices.Actor, s Settings) error`,
  `Status() map[string]OutputStatus` (`LastDeliveredAt`, `Pending`, `LastError`, `LastErrorAt`), `Test(ctx, output string) error`,
  `Run(ctx)`.
- API: `GET /settings/log-export`, `PUT /settings/log-export`, `POST /settings/log-export/test` (spec §4); syslog fields
  accepted and validated now (`host` required when enabled, port 1-65535, facility in `kern…local7` names, format
  `json|text`, `ca_pem` parseable PEM ≤ 64 KB) but the syslog `Output` arrives in t139 (test with `output: "syslog"` → 400
  `syslog output not available yet` until then).
- [ ] Tests first: `TestOutboxTriggers` (audit insert → 1 row; session insert → `start`; `ended_at` set → `end`; second
  update → no row), `TestEveryAuditActionHasSentenceAndCategory`, `TestRecordSessionEnded` (duration), `TestFileRotation`
  (10 MB → `.1`, keep 10, mode 0640), `TestFileOutputUnwritableKeepsBacklog`, `TestExporterDrainsBurstInBatches`,
  `TestEnableStartsAtNow`, `TestCleanupSevenDays`, API roles/validation/audit, gate step (enable file, approve a device, read
  the line). Watch each fail.
- [ ] Implement; go gate → exit 0; web gen:api:check/typecheck/lint/npm test → exit 0; commit.

### Task 2 (t139, Codex Sol high): syslog output
**Files:** `internal/logexport/syslog.go` (+ test), `service.go` (register the output, `Test` for syslog), adminapi tests.
**Interfaces:** consumes `Output`, `Record`; produces `logexport.SyslogOutput{Host, Port, TLS, CAPEM, Facility, Format}`.
- [ ] Tests first against an in-test listener (plain TCP and `tls.Listen` with a generated CA): framing `<len> <msg>`,
  header fields (PRI = facility×8+severity, `rdadmin`, MSGID, HOSTNAME), `json` and `text` bodies (text = sentence +
  `action= outcome= user= source_ip= target= device=`), `TestSyslogOutageThenRecovery`, `TestSyslogTLSHostMismatchRefused`,
  reconnect after the server closes. Watch each fail.
- [ ] Implement; go gate → exit 0; commit.

### Task 3 (t140, Claude `security-auditor`): read-only review of t138 + t139
Focus: SSRF/outbound reach (owner-only), TLS settings, CA handling, no secrets in records, file permissions, trigger
correctness (no event lost or doubled per output), unbounded growth, audit of settings changes. Fixes go to a Round.

### Task 4 (t141, Gemini Medium): Settings → Log Export page
**Files:** a route `web/src/routes/_app/settings/log-export.tsx`, a view component (+ test), the Settings index card.
Owner edits, admins read-only; per-output status (last delivery, waiting, last error); test buttons with their result; a
"Using Zabbix?" hint linking to the README section. No Playwright for Gemini; the Lead runs specs.

### Task 5 (t142, Claude worker or Codex Luna): docs and release 1.7.0
README "Log export" section (what is exported, the record, both outputs, `chown 65532` for `./logs`, the Zabbix agent
`logrt[]` active check and two example triggers), `deploy/.env.example` (no new variables), CHANGELOG 1.7.0; Lead runs the
release gate, tags, publishes.

**Lab check (user):** the Zabbix agent reads `events.jsonl` and a trigger fires on a failed sign-in.
