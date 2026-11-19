# Phase 1a: rulings and deferred items

Decisions made during subagent-driven execution of docs/superpowers/plans/2026-10-06-phase-1a-backend.md, in the order they were made, each with what it costs if wrong. Deferred minors are review findings left for later phases.

## Rulings

- Ruling R1: if sqlc/pgx cannot map inet↔netip.Addr cleanly, map inet to netip.Prefix (or text) at the store layer and convert at the boundary; domain APIs keep netip.Addr; an invalid (zero) Addr is stored as NULL — keeps domain types stable — cost if wrong: small conversion code.
- Ruling R2: Task 10 Deps.QueryOnline is consumed only by Task 12's tracker wiring; servers.Run calls rendezvous.QueryOnline itself as Task 6 specifies — both are in the plan text — cost if wrong: none.
- Task 2: Ruling: accept Dockerfile golang:1.24→1.27 outside the file list — official images set GOTOOLCHAIN=local, so go 1.26 in go.mod would break the compose build — cost if wrong: none.
- Task 2: Ruling: accept REVOKE from PUBLIC + triggers (incl. TRUNCATE) instead of revoking from the app role — the app role owns the table, so a self-revoke is ineffective; triggers carry the guarantee — cost if wrong: a DBA could still drop the triggers as owner.
- Task 2: Ruling: tags.color becomes bigint / int64 (plan said int32 in Task 11) — real Flutter ARGB values like 4280391411 exceed int4; plan text updated — cost if wrong: none.
- Task 3: Ruling: subagent commits carry their own model's Co-Authored-By trailer — correct attribution for who wrote the code — cost if wrong: none.
- Task 4: Ruling: a password is "common" if listed (case-insensitive) or if stripping trailing digits leaves a listed word of length ≥6 — "password1234" is not in SecLists 10k but the plan requires rejecting it — cost if wrong: slightly stricter password rule.
- Task 4: Ruling: fold Minor 1 (canonical PHC parsing) into the Important bounds fix — same parser, same lines — cost if wrong: none.
- Task 5: Ruling: the failure that triggers a lock (5th wrong) returns ErrLocked rather than ErrInvalidCredentials — keeps parallel guesses indistinguishable; plan only fixes the 6th — cost if wrong: one error mapping.
- Task 5: Ruling: Task 10 adds phantom lockout for unknown usernames (in-memory per-lowercased-username failure count with the same LockDuration schedule, returning the same 423 "locked") — otherwise "locked" after 5 guesses confirms an account exists — cost if wrong: small in-memory map.
- Task 5: Ruling: Task 10's session loader must reject sessions of non-active users (Lookup does not check status) and warm the dummy hash at startup — cost if wrong: none.
- Task 7: Ruling: Task 8 UpdateLastSeen only updates rows with state IN ('pending','approved') — a Beat racing an admin reject must not touch the row — cost if wrong: none.
- Task 8: Ruling: UpdateLastSeen uses SELECT unnest(a), unnest(b) subquery (sqlc rejects multi-arg unnest) — same pairing semantics — cost if wrong: none.
- Task 8: Ruling: hbbs-sourced MarkOnline extends the online window but does not write last_seen_at (heartbeat-only) — spec says heartbeat times are flushed; last_seen_at stays "last contacted us" — cost if wrong: devices reachable only via hbbs show stale last_seen.
- Task 8: Ruling: hbbs-sourced presence TTL = ProbeEvery + OnlineWindow (105s); heartbeat window stays 45s (spec) — otherwise hbbs-only devices show offline ~15s of every 60s — cost if wrong: a device that left hbbs shows online up to 105s.
- Task 8: Ruling: probe targets devices without a fresh heartbeat (unexported withoutHeartbeat) instead of Stale() — otherwise hbbs-online devices stop being re-probed and lapse — cost if wrong: none.
- Task 9: Ruling: cmd/ferricade serve is temporarily stubbed when internal/server is deleted; Task 12 rewires it — plan deletes the Phase 0 placeholder here — cost if wrong: serve unusable between Task 9 and Task 12 commits on this branch only.
- Task 9: Ruling: accept once-per-second throttle on cap-forced sweeps — prevents O(n) scan per request at the cap — cost if wrong: transient 429 for a new key right after a sweep.
- Task 10: Ruling: store.Tx gains a deferred rollback (Task 2 minor promoted) — Task 10 adds recover middleware, so a handler panic inside Tx would otherwise leak a tx and its locks — cost if wrong: none.
- Task 10: Ruling: setup.Service CreateOwner/VerifyOwnerTOTP/SaveServer take an extra ip netip.Addr — audit rows need a valid IP in the same tx — cost if wrong: signature churn.
- Task 10: Ruling: phantom lockout does not idle-reset (my decision 4 reversed) — real accounts' failed_logins never decay, so a reset would itself leak existence — cost if wrong: unknown names stay "locked" until evicted (10k cap).
- Task 10: Ruling: owner TOTP verification tracked in settings key setup_owner_totp_verified — totp_last_step can't reflect a regenerated secret — cost if wrong: none.
- Task 10: Ruling: accept extras (auth.mfa_passed audit, per-user TOTP lockout not reset by password login, enrollment requires MFA when TOTP exists) — strictly tighter security — cost if wrong: small extra surface.
- Task 10: Ruling: Minor 1 (hostPattern accepts ":21116"/junk) enters the fix round — it leaves carried decision 7 unmet — cost if wrong: none.
- Task 10: Ruling: Minor 5 (TOTP right after setup/re-enroll fails as a replay and counts toward lockout) re-graded Important by effect — the user's first real sign-in hits it; fix: a replayed-but-valid code returns 400 "code_already_used" and does NOT count toward TOTP/IP lockout — cost if wrong: none (needs a valid code).
- Task 10: Ruling: Minor 4 folded in — wrong TOTP returns 400 "invalid_code" (session stays valid) instead of 401 — same handler; avoids UI treating it as signed-out — cost if wrong: one status code.
- Task 11: Ruling: accept deviations — Transition(from ...string) keeps approve/restore strict without races; device cursor = id only; extra 409 codes bad_transition/username_taken/name_taken; PATCH /groups/{id} rename + POST /groups/{id}/move; setup exports ValidateServer/ValidateProfile; yaml dep for the openapi test — cost if wrong: API-shape churn for 1b.
- Final: Ruling: fix wave also takes Minor 1 (deep link ignored on desktop → README import guidance), Minor 2 (NUL → 400), Minor 3 (setup log line), Minor 5 (healthcheck over TCP), Minor 6 (.dockerignore lab data), Task 11 TOTP-reset deadlock — each hits the user's first real run or is a one-line safety fix — cost if wrong: small diff.
- Final: Ruling: add operator recovery CLI `ferricade user unlock <username>` and `ferricade user reset-totp <username>` (DB-direct, audited with actor null and ActorIP 127.0.0.1) — reviewer recommendation; without it a locked-out sole owner needs raw SQL during the user's test — cost if wrong: small CLI surface.
- Final: Ruling: RELAY_HOST stays required in deploy/compose.yml even without the rustdesk profile — compose validates ${VAR:?} before profiles; failing loudly beats hbbs starting with an empty relay — cost if wrong: users with their own hbbs set a dummy RELAY_HOST.
- Final: Ruling: Argon2 semaphore capacity stays max(2, NumCPU) — bounded; lowering it is a tuning call for the user — cost if wrong: up to NumCPU×64 MiB during a login flood on many-core hosts.

## Deferred minors

- Task 1: minor (deferred): TestLoadDefaults and TestLoadV2Defaults overlap on ClientListenAddr
- Task 2: minor (deferred): store.Tx has no deferred rollback, so a panic in fn leaves the tx open (relevant to Task 10 recover middleware)
- Task 2: minor (deferred): presets NULL/'{}' implicitly signals "sysinfo stored" — Task 7 brief must state the rule
- Task 2: minor (deferred): migration Down and TRUNCATE trigger untested; goose has no session locker (multi-replica race)
- Task 3: minor (deferred): audit.Record accepts empty Action
- Task 3: minor (deferred): audit index is (at DESC, id) but query orders at DESC, id DESC; nullable-filter keyset not index-usable at scale
- Task 3: minor (deferred): zero-value Filter fields mean unset (cannot filter for empty target)
- Task 4: minor (deferred): TOTPURL does not escape ':' in account label
- Task 4: minor (deferred): sealed TOTP seed has no AAD binding to user id (seed copy between rows)
- Task 4: minor (deferred): no negative tests at the digit-stripping boundary
- Task 4: minor (deferred): DefaultParams/TestParams are exported mutable vars
- Task 4: minor (deferred): max-bound Argon2 verify (~10 GiB-passes) still heavy per attempt; login rate limiting is the cap
- Task 5: minor (deferred): recordFailure is two statements; a concurrent correct login can erase failure #5 before its lock lands (doc comment overstates)
- Task 5: minor (deferred): ResetLoginFailures does not re-check status=active; success returns pre-verify snapshot
- Task 5: minor (deferred): IPLimiter keys full IPv6 addresses (/64 rotation bypass, map growth within window)
- Task 5: minor (deferred): CountActiveOwners must be called before the demoting UPDATE (deadlock otherwise) — carry to Task 11
- Task 5: minor (deferred): Rotate (delete+insert) not atomic outside a tx — fails safe (logout)
- Task 6: minor (deferred): rustdesk ID regex allows a leading '-' (Command shows a flag-looking id slot)
- Task 6: minor (deferred): servers.Run with empty host dials localhost — Task 10 must reject empty id/relay host before checks
- Task 6: minor (deferred): APIURL loosely validates idHost/listen port (operator input)
- Task 6: minor (deferred): servers.Run's dial param unused for hbbs step; nil dial panics
- Task 6: minor (deferred): free-port race in check_test; add "123\n"/unicode-digit invalid-ID cases
- Task 7: minor (deferred): same-ID race at the last pending slot can log enroll_dropped / drop one sysinfo (heals next heartbeat)
- Task 7: minor (deferred): open mismatch alert keeps first sighting's details (DO NOTHING per controller decision; spec says upsert)
- Task 7: minor (deferred): MaxPending 0 / nil Beats fail quietly — Task 12 wiring must set them
- Task 7: minor (deferred): drop throttle slot claimed before audit write
- Task 8: minor (deferred): probes.Wait() before final flush can delay shutdown flush if a probe ignores ctx
- Task 8: minor (deferred): Beat reads now() before the lock (older time can win for same id)
- Task 8: minor (deferred): probe MarkOnline accepts IDs not in the batch (unbounded entries)
- Task 8: minor (deferred): no monotonic guard on last_seen_at (Flush must stay single-caller)
- Task 8: minor (deferred): probe silently disabled when query!=nil && approved==nil; merge-back newer-wins branch untested
- Task 8: minor (deferred): a negative hbbs result does not clear hbbsAt (device shows online up to 105s after leaving)
- Task 9: minor (deferred): rate-limit key wiring untested at handler level (rotating XFF from untrusted peer); 500 path untested; ctx-cancel logged at Error; fixture replay doesn't assert heartbeat JSON
- Task 9: minor (deferred): cap-forced sweep branch not distinctly tested; hostile active /64s can hold the map at cap (fail-closed by design)
- Task 10: minor (deferred): BeginOwnerTOTP replaces secret without audit; wrong current password at /auth/password not audited/counted per account
- Task 10: minor (deferred): recoverer writes 500 after headers started; client routes under admin recoverer get admin error shape on panic
- Task 10: minor (deferred): setupAvailable queries DB on every /setup request; TestInternalErrorHasRequestID builds chain by hand; enrollments.put O(n) at cap
- Task 10: minor (deferred): phantom/TOTP lockout state is per-process memory (restart/eviction makes names distinguishable) — document
- Task 10: minor (deferred): multi-IP concurrent password bursts against one account are still checked concurrently in auth.Login (DB counter records after verify) — per-IP reservation caps 20/IP
- Task 10: minor (deferred): a refused TOTP reservation (in-flight only) answers 423 locked and audits/counts as failure
- Task 10: minor (deferred): IP slot taken before body read; no ReadTimeout yet (Task 12 sets server timeouts)
- Task 10: minor (deferred): all-numeric dotted names (256.1.1.1) pass as DNS names; port "01" accepted; stale lockout.go comments
- Task 11: minor (deferred): resetUserTOTP vs patchUser lock order can deadlock (40P01 → 500); fix with FOR NO KEY UPDATE
- Task 11: minor (deferred): errAlertNoUUID maps to 500 (unreachable in practice)
- Task 11: minor (deferred): device uuid pin exposed to all admins in API/audit (lets an admin spoof an approved device's sysinfo) — surface to user
- Task 11: minor (deferred): conns shown while offline; no-op PATCH audits; unknown-device cursor → empty page; no index for ORDER BY rustdesk_id,id; test sort helpers; service.go 712 lines
- Task 12: minor (deferred): adminapi.Deps.QueryOnline dead wiring; pre-setup client requests query DB each time (no negative cache); duplicated test DB URL helper; checkConfig lacks https:21114 rule (test-only path); second Ctrl-C swallowed during drain; README client-derivation claim unverified with a real client
- Final: minor (deferred): CLI reset-totp sets totp_last_step=0, breaking the only-grows invariant comment (harmless: new secret)
