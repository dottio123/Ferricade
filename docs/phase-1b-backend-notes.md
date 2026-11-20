# Phase 1b backend: rulings and deferred items

Decisions made while executing docs/superpowers/plans/2026-10-06-phase-1b-backend.md (subagent-driven, 2026-10-07), in order, each with what it costs if wrong. Deferred items are review findings left for later; the final review triaged them (see the last section).

## Rulings

- | self 3 | needs devices.Lookup exported from internal/devices (not in its Files list) | Ruling P1 |
- | self 8 | needs GetDeviceIDByRustdeskID in internal/store/queries/devices.sql (not in its Files list) | Ruling P2 |
- | self 4 | needs `import _ "time/tzdata"` in cmd/ferricade (not in its Files list) | Ruling P3 |
- Ruling P1: Task 3 may add an exported devices.Lookup in internal/devices (and its query) — the plan's Interfaces require it — cost if wrong: none.
- Ruling P2: Task 8 may add GetDeviceIDByRustdeskID to internal/store/queries/devices.sql and regenerate — required by its Interfaces — cost if wrong: none.
- Ruling P3: Task 4 may edit cmd/ferricade/main.go for the tzdata import — required by its Interfaces — cost if wrong: none.
- Task 1: Ruling: accept client.doOutsideContract for the 4 router-fallback tests on undocumented paths — it refuses documented routes, so it cannot bypass validation — cost if wrong: none.
- Task 1: Ruling: accept IgnoreArrayCircularReferences (libopenapi misreports Group.children recursion) — narrow, commented — cost if wrong: recursive arrays not cycle-checked.
- Task 2: Ruling: fix the reordering with a delivery mutex (notifyMu before mu, held through callback delivery); fold in Minor test fixes (outside-lock test deadline + offline path, Run sweep wiring test) — the tests could not otherwise catch the race — cost if wrong: a slow callback slows heartbeats (callbacks only enqueue to the hub).
- Task 3: Ruling: the new table is `remote_sessions` (model db.RemoteSession, queries in internal/store/queries/remote_sessions.sql); `sessions` is already the admin login-session table. Migration file 00002_sessions.sql, package internal/sessions, notify kind "session", API path /sessions keep their names. Tasks 4, 5, 8 use remote_sessions in SQL — the plan's "sessions" table text means remote_sessions — cost if wrong: a rename later.
- Task 3: Ruling: a "new" record for a conn_id whose open session was opened by an auth record (client_ip IS NULL AND authed_at IS NOT NULL) merges into it (sets client_ip, keeps the earlier started_at) instead of closing it as stale; any other existing open session is closed as stale as briefed — keeps peer details when a retry reorders new/auth — cost if wrong: none.
- Task 3: Ruling: before setup (or nil Sessions) /api/audit/conn answers {} without validating, like heartbeat — consistent client API — cost if wrong: none.
- Task 3: Ruling: sessions store the record's own ip (the connecting peer); Ingest's request-ip parameter stays unused but documented — cost if wrong: none.
- Task 3: Ruling: ⚠️ sessions of a device that stops heartbeating stay open — Task 5's periodic runner also closes every open remote_session whose conn_seen_at is older than StaleAfter (ended_at = conn_seen_at, end_reason 'stale'), every minute; safe because clients heartbeat every 3 s while a session is open — cost if wrong: none.
- Task 3: Ruling: Task 5's migration 00003 also adds an index on seen_nonces(seen_at) for the 7-day pruning — cost if wrong: none.
- Task 4: Ruling: adminapi.Deps field is RemoteSessions (Deps.Sessions is already *auth.Sessions) — cost if wrong: none.
- Task 4: Ruling: per_day counts a session (and its whole duration) on the day it started in the requested tz; no midnight splitting; range defaults to 7d; bad range/tz (incl. "Local") → 400 — simple and predictable for charts — cost if wrong: long overnight sessions inflate their start day.
- Task 4: Ruling: re-grade Minors "forged cursor → 500" and "Go/Postgres tz mismatch → 500" to Important (input-triggered 500s), and fold in the keyset tie-break test — cost if wrong: none.
- Task 5: Ruling: re-grade Minor 1 (startup snapshot records online=0 before any heartbeat, frozen for 90 d by ON CONFLICT DO NOTHING) to Important — a false dip on the trend chart after every restart — fix: no snapshot until the tracker has been running ≥ devices.OnlineWindow (45 s); fold in Minor 2 (vary pending in TestHistoryDownsample) — cost if wrong: the first slot after a restart may have no point (a gap, which charts show honestly).
- Task 6: Ruling: accept summary interpretations — os in fixed order without zero counts; versions newest first, empty = "unknown" (last, never outdated); outdated_client.since = first_seen_at; groups lists every group incl. empty, Ungrouped only when non-empty; sessions.active = open sessions of approved devices; alerts.open = all unresolved alerts; PUT replaces all three thresholds (missing field → 400 naming it); nil Tracker = all offline — cost if wrong: small UI wording changes.
- Task 7: Ruling: accept — PUT requires all five fields, modules may be a subset (missing catalog modules appended disabled); stored pins kept as submitted, dropped only in responses when not approved; invalid stored theme/density/preset fall back to defaults; decodeLimit split from decode — cost if wrong: none.
- Task 7: Ruling: fold Minor "log unreadable stored prefs at WARN" into fix round 1 — invisible corruption otherwise — cost if wrong: none.
- Task 8: Ruling: after Listen reconnects, the hub closes every subscriber channel (Hub.Resync) so Task 9's SSE sends `resync` and the UI refetches — notifications during the outage are otherwise silently lost — cost if wrong: one extra refetch per reconnect.
- Task 8: Ruling: test device.offline through the bridge directly (fake OnChange input), not the 45 s sweep — cost if wrong: none.
- Task 8: Ruling: the ~110-line tracker→hub bridge stays in app.go per the plan's file list, unless it gets its own file in internal/events (implementer's choice) — cost if wrong: none.
- Task 9: Final ruling (2026-10-11): each ping tick re-validates the session READ-ONLY and ends the stream if it was logged out, expired, disabled, or lost MFA state. A separate keepalive touches a still-valid session once a minute, so an open console tab keeps it alive; without an open tab, idle expiry is 5 minutes.
- Task 9: Ruling: per-send write deadline (10 s) instead of clearing it once; also clear the read deadline explicitly and prove with a ReadTimeout test — cost if wrong: none.
- Task 9: Ruling: a DB error during the ping-time session check keeps the stream for the next tick (fail-open for one 25 s interval) — the stream carries IDs only, and a transient DB blip should not drop every UI — cost if wrong: a revoked session's stream lives ≤ 25 s longer per failed check.
- Task 11: Ruling: rdsim SessionEvery is the pause between a close and the next start (not start-to-start) — the start-to-start reading made sessions overlap heartbeats and the test flaky — cost if wrong: a flag description.
- Task 11: Ruling: fold Minor 1 (sim session_id + primary_auth like the fixtures) and Minor 3 (best-effort close on shutdown) into fix round 1 — rdsim is the UI's development data source, so ghost live sessions and fixture drift cost later — cost if wrong: none.
- Final: Ruling: add `session.updated` (trigger AFTER UPDATE OF authed_at, migration 00006) and `device.updated` on sysinfo changes (trigger on devices hostname/os/client_version/username change, same migration) — the UI otherwise shows live sessions as "unknown" and stale device details — cost if wrong: a few more refetches.
- Final: Ruling: aggregates (sessions/stats per_day, average, top devices; snapshot sessions; summary sessions.active) count only authenticated sessions (authed_at IS NOT NULL); GET /sessions lists all and gains `authenticated=true|false` — failed passwords and denied requests would otherwise inflate every chart — cost if wrong: attempts invisible in charts (still listed).
- Final: Ruling: fix wave also takes Minors 1 (contract rejects empty/null bodies), 2 (serve existing root static files), 3 (gate branches on web.Assets()), 4 (folded into the device.updated trigger), 6 (WARN rate-limited on audit/conn rejections), 8 (to_char day labels), plus deferred T3 COALESCE and AGENTS.md update — each blocks the UI work or the real-client run — cost if wrong: small diff.
- Final: Ruling: resync payload is {"type":"resync"} (a valid LiveEvent) instead of {} — every data line validates against the contract — cost if wrong: none.
- Final: Ruling: shutdown uses Hub.Close (Resync + refuse new subscriptions) instead of plain Resync — a stream opened during shutdown would otherwise hold it for 10 s — cost if wrong: none.
- Final: Ruling: UI dotfiles (e.g. web/dist/.gitkeep) are never served — cost if wrong: none.

## Deferred findings

- Task 1: minor (deferred): closure check keys on type "object" only (properties without type would slip); 204 headers not checked; contractModel may t.Fatalf off-goroutine in burst; request bodies/params not closure-checked; mismatch cases only on /auth/me
- Task 1: deferred check for FINAL REVIEW: confirm the validator rejects a 200 with an empty body and with text/plain on a documented JSON route (reviewer could not verify library behaviour from the diff)
- Task 2: minor (deferred): over-long Run doc line and stray blank line — folded into fix round 1
- Task 2: minor (deferred): heartbeat callers now serialise behind callback delivery
- Task 3: minor (deferred): a late 'new' with an invalid ip leaves client_ip NULL, so a later conn_id reuse merges again instead of closing stale (stale sweep still ends it)
- Task 3: minor (deferred): merge predicate matches any open authed session without client_ip (not only auth-opened); late fresh-nonce auth/new after close opens a phantom session (stale-closed in 60 s); concurrent heartbeats with different conns can deadlock (logged, self-heals); second auth can null type/peer_name (use COALESCE); long doc line ingest.go:32; no same-conn concurrency test; AGENTS.md clientapi route list stale
- Task 4: minor (deferred): stats total_seconds rounds while list duration_seconds truncates; future-dated starts count in top_devices but not per_day/average; DST week has no data; Tokyo assertion only checks length
- Task 4: minor (deferred): unknown-zone 400 tested at service level only (no HTTP test)
- Task 5: minor (deferred): oldest 7d/30d bucket is partial (undocumented); Take not in one transaction (online may exceed approved once); 60 s exact boundary of CloseStale untested
- Task 5: minor (deferred): a failed Take is not retried within its slot
- Task 6: minor (deferred): min_client_version parts unbounded (\d{1,9} cap); summary queries ignore server_id (fine: one server in Phase 1, revisit in Phase 3); open alerts on archived/rejected devices appear in attention; non-numeric versions compare as 0; audit field asserts / rollback / sort-tie tests missing; DefaultThresholds exported mutable var
- Task 7: minor (deferred): uuid.Parse accepts non-canonical UUID forms; stored pins not de-duplicated on read; no tests for invalid stored theme/density/preset fallback, repeated stored modules, the notify payload, or a PUT module subset; no maxItems on modules in openapi
- Task 8: minor (deferred, FINAL REVIEW triage): no resync when the FIRST connect fails; half-open LISTEN connection not detected (no periodic ping); flapping resets backoff → resync storm; failed bridge lookup / dropped bridge event has no resync; 100 ms deadline in bridge test; backoff doubling/cap untested; empty UserID matches "" subscribers for preferences.updated
- Task 9: minor (deferred): SetWriteDeadline/SetReadDeadline errors ignored silently; resync send result ignored; waitListening matches pg_stat_activity text (brittle)
- Task 10: minor (deferred, FINAL REVIEW triage): /assets 404 and 405 lack Cache-Control: no-store (a proxy could cache a 404 for a hashed asset across a deploy); no traversal-form tests; /setup/status test checks only one key; placeholder no-store unasserted; no web/assets_test.go; fs.ReadFile copies every asset per request; /setup/status unrate-limited DB read
- Task 11: minor (deferred): Stats.Sessions counts sessions the server ignored (unknown device); no close posted if auth fails; openEvents drops events silently when its buffer fills; uneven comment wrap in sim.go
- Final: minor (deferred): events_test panics on empty slow-reader output; checkLiveEvent rebuilds the validator per line (slow adminapi tests); NUL inside id kept (escaped) in reject log; last window's suppressed count not emitted; plan text says migrations 00002–00005 (now 00006); client and admin listeners shut down sequentially

## Final review triage

- Fixed before the UI work: contract rejects empty/null bodies; root static files served; gate tolerates a built UI; AGENTS.md updated; COALESCE on auth; to_char day labels; audit/conn rejection logging.
- Before an internet-facing release: detect a half-open LISTEN connection (periodic ping); cache /setup/status once true.
- Not fixed, watch in the real-client run: a phantom session when a close arrives before its new (the reviewer advised fixing it before the run; impact is smaller now that unauthenticated sessions no longer count in totals, but the live list can show a ghost for up to about 2 minutes). Fix by ignoring new/auth records for a recently closed conn_id.
- Everything else can wait.
