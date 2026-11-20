# Log export: readable access and action logs for Zabbix and SIEMs (design)

Status: approved in conversation (user, 2026-10-21), sections 1-4. Author: Project Lead 8. Ships as **1.7.0** on `main`
(the macOS deployment work follows later). Research: `docs/orchestration/specs/2026-10-21-log-export-research.md`.

## Goal
Send rdadmin's **action log** (the audit trail) and **access log** (remote sessions) to monitoring and SIEM tools in a
form that is readable by people and parseable by machines. The design is compatible with Zabbix while remaining generic.
v1 outputs: a **JSON-lines file** and **syslog** (RFC 5424 over TCP, optional TLS). No Zabbix-specific code; a Zabbix
how-to in the README.

## 1. The event record
One JSON object per event, one line, UTF-8. Field names follow the Elastic Common Schema (ECS) where one exists;
rdadmin-specific fields live under `rdadmin.*`.

```json
{"@timestamp":"2026-10-21T14:03:12.481Z",
 "event":{"id":"…","kind":"event","category":"configuration","action":"access_window.opened","outcome":"success"},
 "message":"jane (Admin) opened a 1-hour access window on Front Desk PC (123456789) from 203.0.113.5",
 "user":{"id":"…","name":"jane","roles":["admin"]},
 "source":{"ip":"203.0.113.5"},
 "rdadmin":{"target":{"type":"device","id":"…","name":"Front Desk PC"},"device":{"rustdesk_id":"123456789"},"details":{}},
 "observer":{"product":"rdadmin","version":"1.7.0","hostname":"rdadmin.example.com"}}
```
- **Sources:** every `audit_events` row; every `remote_sessions` start and end (`event.action` `session.started` /
  `session.ended`, `event.category` `session`, peer and device; `rdadmin.session.duration_seconds` on end).
- **`event.category`** per action: `authentication` (sign-in, MFA, logout, lockouts), `iam` (users, roles, grants, OIDC
  links), `configuration` (devices, groups, tags, policies, push, access windows, deployment, server, settings),
  `session` (sessions). A table in code; a test fails if an audit action has no category.
- **`event.outcome`:** `failure` for refusals (failed sign-in and similar), else `success`.
- **`event.id`:** the audit row id; for sessions `<session id>:start` / `<session id>:end`. Stable for de-duplication.
- **`message`:** the readable sentence (who, with role, did what, to which named target, from which IP), produced
  server-side by `internal/logexport/describe.go`, worded like the audit page (`web/src/features/audit/describe.ts`).
  System actions (the access-window sweep) read "rdadmin (system) …".
- **`observer.hostname`:** the host of `PUBLIC_URL`. No secrets ever (the audit trail stores none; the export adds
  only names).

## 2. Delivery
- **Outbox:** new table `log_export_outbox` (`id bigserial`, `source` `audit` | `session`, `ref_id`, `phase`
  `start` | `end` | null, `created_at`, `file_done_at`, `syslog_done_at`). Database triggers insert a row in the **same
  transaction** as each `audit_events` insert and each `remote_sessions` insert / `ended_at` change.
- **Exporter loop** (`internal/logexport`), started and stopped with the app like the stats snapshotter: every 2 s, per
  enabled output, select up to 500 rows that output has not done (`<output>_done_at IS NULL`, ordered by `id`), build
  the records, deliver, set `<output>_done_at`. "Not done" selection (not a moving cursor) means a late-committing
  transaction is never skipped.
- **Failures:** retry with backoff up to 1 min; the backlog stays; order is kept. At-least-once delivery.
- **Cleanup:** delete rows done by every enabled output, and every row older than **7 days**.
- **Enabling an output starts at now:** existing rows are marked done for that output when it is switched on.
- **Status per output** (kept in memory and the settings row): last delivery time, events waiting, last error and time.

## 3. Outputs
**JSON-lines file:** `/var/log/rdadmin/events.jsonl` in the container; `deploy/compose.yml` (and `compose.dev.yml`)
mount `./logs:/var/log/rdadmin`. Rotation at 10 MB to `events.jsonl.1` … keeping 10 files; files mode `0640`. The README
shows a Zabbix agent active check `logrt["<host path>/events\.jsonl.*", …]` with example triggers (`"outcome":"failure"`,
`access_window.opened`); any shipper (Filebeat, Fluent Bit, the Wazuh agent) reads the same file.

**Syslog:** RFC 5424 over TCP, octet-counting framing (RFC 6587). `APP-NAME` `rdadmin`, `MSGID` = `event.action`,
`HOSTNAME` = `observer.hostname`, severity **warning** for failures, **notice** otherwise, facility configurable
(default `local0`). Settings: `host`, `port` (default 6514 with TLS, 514 without), `tls` (TLS 1.2+, system roots plus an
optional `ca_pem`, host name verified), `facility`, `format`: **`json`** (MSG = the record; default) or **`text`** (MSG =
the sentence then `key=value` pairs for action, outcome, user, source_ip, target, device).

**Both:** off by default; independent switches; **Send test event** (`rdadmin.test`) delivers one event directly and
returns success or the exact error.

## 4. API, UI, security, tests, rollout
- **API** (contract first):
  - `GET /settings/log-export` (owner, admin; Users 403) → settings + per-output status.
  - `PUT /settings/log-export` (**owner**) → body `{file:{enabled}, syslog:{enabled, host, port, tls, ca_pem, facility,
    format}}`; 400 naming the field (host required when enabled, port 1-65535, CA PEM parseable and ≤ 64 KB, known
    facility/format); audited `settings.log_export_updated` with the changed fields.
  - `POST /settings/log-export/test` (**owner**) `{output: "file"|"syslog"}` → `{ok, error}`; not audited.
- **Migration:** the settings row (single-row table, `id boolean = true`), the outbox, the triggers.
- **UI:** Settings → **Log Export** (Gemini designs): the two outputs, status, test buttons, a "Using Zabbix?" hint
  linking to the README section; admins read-only.
- **Security:** owner-only changes; TLS option with host verification; outbound only to the configured host; file mode
  `0640`; no secrets in events; a Claude `security-auditor` review after the backend task.
- **Tests:** Go table test of the sentence and category for every audit action (fails on a new uncovered action); the
  outbox triggers; the exporter against an in-test TCP and TLS syslog listener (framing, order, retry after an outage,
  at-least-once, 7-day cleanup, start-at-now); file rotation; API roles and validation; a backend-gate step (enable the
  file output, act, read the lines). Web: Vitest + mocks; the settings Playwright spec.
- **Lab check (user):** the Zabbix agent reads the file and a trigger fires on a failed sign-in.
- **Rollout:** a Codex task (backend: migration, outbox, exporter, outputs, sentences, API, tests, mocks), the security
  review, a Gemini task (settings page), a docs + release task (README "Log export" + Zabbix how-to, CHANGELOG 1.7.0).

## Out of scope (v1)
Zabbix `history.push` and webhooks (possible phase 2); filtering which events are exported; pulling logs over an API
(no API tokens); RFC 3164 syslog; UDP; client certificates for syslog TLS.
