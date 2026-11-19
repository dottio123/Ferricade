# Phase 1a: Backend Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend that enrolls RustDesk devices into an approval queue, tracks them online, and gives authenticated admins (password + TOTP) a JSON API to approve, organize, and connect to them.

**Architecture:** One binary with two HTTP listeners: the client API on `:21114` and the admin API plus setup on `:21120` behind HTTPS. Both share a pgx pool on Postgres 16. Domain packages (`auth`, `devices`, `setup`, `servers`, `connect`, `audit`) sit on sqlc-generated queries. HTTP packages (`clientapi`, `adminapi`, `httpx`) stay thin over them.

**Tech Stack:** Go (go.mod `go 1.26`, CI `1.27.x`), pgx v5.11, goose v3.28 (embedded migrations), sqlc v1.31.1 (generated code committed), google/uuid v1.6, golang.org/x/crypto (argon2, hkdf), golang.org/x/time/rate, chi v5, testify.

**Spec:** `docs/superpowers/specs/2026-10-06-phase-1a-backend-design.md` (parent: the Claude Docs "RustDesk Admin WebUI: Implementation Plan").

## Global Constraints

- Postgres 16 only; no SQLite code paths.
- Every timestamp is `timestamptz` / `time.Time` in UTC; every ID is `uuid` / `uuid.UUID`, except `devices.rustdesk_id` and `devices.uuid`, which are client text.
- sqlc config: engine `postgresql`, `sql_package: pgx/v5`, `emit_pointers_for_null_types: true`, with overrides `uuid → github.com/google/uuid.UUID` and `inet → net/netip.Addr`. Generated code lives in `internal/store/db` and is committed. CI runs `sqlc diff`.
- Client API error shape: `{"error":"<msg>"}`. Admin API error shape: `{"error":{"code":"…","message":"…"}}`, plus `request_id` for `internal`.
- Defaults: `CLIENT_LISTEN_ADDR :21114`, `ADMIN_LISTEN_ADDR :21120`, `MAX_PENDING_DEVICES 500`, online window 45 s, flush every 30 s, hbbs probe every 60 s in batches of 1000.
- Argon2id `m=65536,t=3,p=2`, 16-byte salt, 32-byte key, PHC string `$argon2id$v=19$m=65536,t=3,p=2$<b64salt>$<b64hash>` (raw std base64, no padding).
- TOTP per RFC 6238: SHA-1, 6 digits, 30 s step, ±1 step, 20-byte secret in base32 without padding, issuer `rdadmin`.
- Sessions: cookie `__Host-rdadmin_session` (`rdadmin_session` when `DEV_INSECURE`), 12 h idle and 7 d absolute, CSRF header `X-CSRF-Token`.
- Lockout: 5 consecutive failures give 1 min, then double for each further failure up to 1 h. Per IP, 20 failures in 10 min give 429.
- Client limits: 64 KiB body, per-IP 20 req/s with burst 40.
- Every state-changing admin action writes `audit_events` in the same transaction as the change.
- Tests needing Postgres use `TEST_DATABASE_URL`. They skip when it is unset unless `REQUIRE_DB=1`, which CI sets, so they fail there instead.

## Review Focus

1. **TOTP code replay:** a valid code used once must not work again within its ±1-step window, or an observer could reuse it. Task 4 `TestVerifyTOTPRejectsReplay`; Task 4 adds `users.totp_last_step`.
2. **Concurrent first heartbeat and sysinfo from one new device:** both race to insert. Exactly one `pending` row and one `device.enrolled` audit event must result, never a 500. Task 7 `TestConcurrentEnrollmentCreatesOneDevice`.
3. **Last owner disabled or demoted:** the API refuses with `409 last_owner`, so the instance can never be locked out. Task 11 `TestCannotRemoveLastOwner`.
4. **Group cycles and deep trees:** moving a group under its own descendant is refused with `409 cycle`. Task 11 `TestMoveGroupUnderDescendantRefused`.
5. **Clock skew and expiry edges:** a session exactly at 12 h idle is expired, and a setup token at 24 h is rejected. Task 5 `TestSessionIdleBoundary`, Task 10 `TestSetupTokenExpires`.

---

## File Structure

```
go.mod                                  go 1.26; new deps
Makefile                                + test-db, sqlc targets
.github/workflows/ci.yml                + postgres service, sqlc diff, REQUIRE_DB=1
deploy/compose.yml                      app + postgres:16 (dev/prod example)
sqlc.yaml
internal/config/config.go               Config v2
internal/store/migrations/00001_init.sql all tables, trigger, indexes
internal/store/queries/*.sql            one file per area
internal/store/db/                      sqlc output (generated)
internal/store/store.go                 Open, Migrate, Tx
internal/store/testdb.go                NewTestDB (exported test helper)
internal/audit/audit.go
internal/auth/{password.go,common.txt,totp.go,sealer.go,session.go,lockout.go,login.go}
internal/devices/{service.go,tracker.go,groups.go,tags.go}
internal/httpx/{clientip.go,ratelimit.go,json.go}
internal/clientapi/handler.go
internal/servers/check.go
internal/connect/{link.go,config.go}
internal/setup/{guard.go,service.go}
internal/adminapi/{router.go,middleware.go,errors.go,auth.go,users.go,devices.go,groups.go,tags.go,server.go,audit.go,setup.go,openapi.yaml}
cmd/rdadmin/main.go                     serve wiring
internal/e2e/gate_test.go               Phase 1a gate
```

---

### Task 1: Config v2

**Files:**
- Modify: `internal/config/config.go`, `internal/config/config_test.go`

**Interfaces:**
- Produces: `config.Config{ClientListenAddr, AdminListenAddr, HBBSAddr, DatabaseURL string; PublicURL *url.URL; TrustedProxies []netip.Prefix; SecretKey []byte; MaxPendingDevices int; DevInsecure bool}`; `config.Load(getenv func(string) string) (Config, error)`. Constants `DefaultClientListenAddr = ":21114"`, `DefaultAdminListenAddr = ":21120"`, `DefaultHBBSPort = "21115"`, `DefaultMaxPending = 500`.

- [ ] **Step 1: Update and add tests.** Keep the Phase 0 tests, renaming `ListenAddr` to `ClientListenAddr` and `LISTEN_ADDR` to `CLIENT_LISTEN_ADDR`. A shared helper `base()` returns a valid env (`PUBLIC_URL=https://admin.example.com`, `DATABASE_URL=postgres://x`, `SECRET_KEY` = base64 of 32 bytes). New tests:

```go
func TestLoadV2Defaults(t *testing.T)            // ClientListenAddr ":21114", AdminListenAddr ":21120", MaxPendingDevices 500, DevInsecure false, len(SecretKey)==32
func TestLoadRequiresDatabaseURL(t *testing.T)    // err contains "DATABASE_URL"
func TestLoadSecretKeyTooShort(t *testing.T)      // base64 of 31 bytes → err contains "SECRET_KEY"; non-base64 → err
func TestLoadHTTPPublicURLNeedsDevInsecure(t *testing.T) // http://… → err contains "DEV_INSECURE"; with DEV_INSECURE=1 → ok, DevInsecure true
func TestLoadMaxPending(t *testing.T)             // "50" → 50; "0", "-1", "x" → err
```

- [ ] **Step 2: Run** `go test ./internal/config/...`. Expected: FAIL (unknown fields).
- [ ] **Step 3: Implement.** `SECRET_KEY` accepts std or raw-std base64 and needs at least 32 decoded bytes. `DEV_INSECURE` is true only for `1`. The old `LISTEN_ADDR` is not read. Update `cmd/rdadmin/main.go` so it compiles: `serve` uses `ClientListenAddr` until Task 12, and `record`'s default listen becomes `DefaultClientListenAddr`.
- [ ] **Step 4: Run** `go test ./... && go vet ./...`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(config): v2 settings for split listeners and Postgres`.

---

### Task 2: Store foundation (Postgres, migrations, sqlc, test DB, CI)

**Files:**
- Create: `internal/store/migrations/00001_init.sql`, `internal/store/store.go`, `internal/store/testdb.go`, `sqlc.yaml`, `internal/store/queries/settings.sql`, `deploy/compose.yml`
- Modify: `go.mod` (go 1.26), `Makefile`, `.github/workflows/ci.yml`
- Test: `internal/store/store_test.go`

**Interfaces:**
- Produces:
  - `store.Open(ctx context.Context, url string) (*pgxpool.Pool, error)`
  - `store.Migrate(ctx context.Context, pool *pgxpool.Pool) error`, which runs embedded goose migrations through `stdlib.OpenDBFromPool`
  - `store.Tx(ctx context.Context, pool *pgxpool.Pool, fn func(q *db.Queries) error) error`
  - `store.NewTestDB(t testing.TB) *pgxpool.Pool`
  - package `db`: sqlc's `db.New(db.DBTX) *db.Queries`, plus queries `GetSetting(ctx, key string) ([]byte, error)` and `PutSetting(ctx, db.PutSettingParams{Key string; Value []byte}) error` (upsert)

Migration `00001_init.sql` creates every table in the spec's data model, with these exact additions:
- `CREATE EXTENSION IF NOT EXISTS citext;`
- `users.totp_last_step bigint NOT NULL DEFAULT 0` (Review Focus 1)
- `users.role` and `devices.state` as text with CHECK constraints listing the spec's values
- `device_groups` unique `(parent_id, name)` using `NULLS NOT DISTINCT`
- partial unique index `device_alerts(device_id, kind) WHERE resolved_at IS NULL`
- index `devices(server_id, state)` and index `audit_events(at DESC, id)`
- function `audit_events_immutable()`, which raises `audit_events is append-only`, attached by triggers `BEFORE UPDATE OR DELETE` on `audit_events`

- [ ] **Step 1: Write failing tests.**

```go
func TestMigrateIsIdempotent(t *testing.T)        // NewTestDB, then Migrate twice more → no error
func TestSettingsRoundTrip(t *testing.T)          // PutSetting("setup_complete", `true`), GetSetting → `true`; Put again `false` → `false`
func TestAuditEventsAppendOnly(t *testing.T)      // insert a row with raw SQL; UPDATE → error contains "append-only"; DELETE → same
func TestTxRollsBackOnError(t *testing.T)         // Tx writes a setting then returns errors.New("x") → GetSetting returns pgx.ErrNoRows
func TestNewTestDBIsolated(t *testing.T)          // two NewTestDB calls return different current_database()
```

- [ ] **Step 2: Start a local Postgres and run** `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable REQUIRE_DB=1 go test ./internal/store/...`. Expected: FAIL (package missing). `make test-db` runs `docker run -d --name rdadmin-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`. Without Docker, use a local Postgres 16 with the same URL.
- [ ] **Step 3: Implement.** `NewTestDB` connects to `TEST_DATABASE_URL`, creates `rdadmin_test_<16 hex>`, opens a pool on it, runs `Migrate`, and registers a cleanup that closes the pool and drops the database `WITH (FORCE)`. With no URL it calls `t.Skip("TEST_DATABASE_URL not set")`, or `t.Fatal` when `REQUIRE_DB=1`. `Tx` uses `pool.BeginTx` with read-committed isolation, commits on nil, and rolls back otherwise. Add Makefile targets `sqlc: go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate` and `test-db`. In CI, add a `postgres:16` service, the env vars `TEST_DATABASE_URL` and `REQUIRE_DB=1`, a `sqlc diff` step (`go run …@v1.31.1 diff`), and set go-version `1.27.x`. `deploy/compose.yml` defines `db` (`postgres:16`, a named volume, a healthcheck) and `app` (build `../`, `command: ["serve"]`, ports `21114:21114` and `21120:21120`, env `DATABASE_URL`, `SECRET_KEY`, `PUBLIC_URL`, depends on db healthy).
- [ ] **Step 4: Run** `make sqlc`, then `go test ./internal/store/...` with the env from Step 2. Expected: PASS. Then run `go test ./...`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(store): Postgres schema, migrations, sqlc and test DB`.

---

### Task 3: Audit log

**Files:**
- Create: `internal/audit/audit.go`, `internal/store/queries/audit.sql`
- Test: `internal/audit/audit_test.go`

**Interfaces:**
- Consumes: `store.Tx`, `store.NewTestDB`, `db.Queries`.
- Produces:
  - `audit.Event{ActorUserID *uuid.UUID; ActorIP netip.Addr; Action, TargetType, TargetID string; Details map[string]any}`
  - `audit.Record(ctx context.Context, q *db.Queries, e audit.Event) error`
  - `audit.Filter{Action, TargetID string; ActorUserID *uuid.UUID; Since, Until time.Time; Limit int; Cursor string}`
  - `audit.Entry{ID uuid.UUID; At time.Time; ActorUserID *uuid.UUID; ActorIP netip.Addr; Action, TargetType, TargetID string; Details map[string]any}`
  - `audit.List(ctx context.Context, q *db.Queries, f audit.Filter) ([]audit.Entry, string, error)`, which returns entries newest first and the next cursor (empty at the end). The cursor is an opaque base64 of `(at, id)`. `Limit` defaults to 50 and is capped at 200.

- [ ] **Step 1: Write failing tests.**

```go
func TestRecordAndList(t *testing.T)            // 3 events → List returns 3, newest first, Details round-trips
func TestListFiltersByAction(t *testing.T)      // actions a,b,a → Filter{Action:"a"} returns 2
func TestListPaginates(t *testing.T)            // 5 events, Limit 2 → pages of 2,2,1; last cursor ""
func TestRecordRollsBackWithTx(t *testing.T)    // Record inside store.Tx that returns error → List empty
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** with sqlc queries `InsertAuditEvent` and `ListAuditEvents`. The list query uses keyset `(at, id) < ($cursor_at, $cursor_id)` and nullable filter params via `sqlc.narg`.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(audit): append-only audit log`.

---

### Task 4: Password, TOTP and secret sealing

**Files:**
- Create: `internal/auth/password.go`, `internal/auth/common.txt` (embedded; the 10,000 most common passwords, one per line, lowercase, taken from the SecLists `10k-most-common.txt` (MIT) with attribution in a header comment), `internal/auth/totp.go`, `internal/auth/sealer.go`
- Test: `internal/auth/password_test.go`, `internal/auth/totp_test.go`, `internal/auth/sealer_test.go`

**Interfaces:**
- Produces:
  - `auth.Params{Memory uint32; Iterations uint32; Parallelism uint8; SaltLen, KeyLen uint32}`, with `auth.DefaultParams` (spec values) and `auth.TestParams` (`Memory 64, Iterations 1, Parallelism 1`)
  - `auth.HashPassword(pw string, p auth.Params) (string, error)`
  - `auth.VerifyPassword(encoded, pw string) (bool, error)`, which reads the params from `encoded` and compares in constant time
  - `auth.ValidatePassword(username, pw string) error`, returning `auth.ErrPasswordTooShort`, `auth.ErrPasswordCommon` or `auth.ErrPasswordIsUsername`
  - `auth.NewTOTPSecret() (string, error)`
  - `auth.TOTPURL(account, secret string) string`, which builds `otpauth://totp/rdadmin:<account>?secret=…&issuer=rdadmin&algorithm=SHA1&digits=6&period=30`
  - `auth.VerifyTOTP(secret, code string, now time.Time, lastStep int64) (step int64, ok bool)`, which accepts only a step greater than `lastStep`
  - `auth.NewSealer(key []byte) (*auth.Sealer, error)`, `(*Sealer).Seal(plain []byte) ([]byte, error)`, `(*Sealer).Open(sealed []byte) ([]byte, error)`, using AES-256-GCM with an HKDF-SHA256 key (info `totp-v1`) and a random 12-byte nonce prefix

- [ ] **Step 1: Write failing tests.**

```go
func TestHashVerifyPassword(t *testing.T)       // TestParams; right pw true, wrong false; encoded has prefix "$argon2id$v=19$m=64,t=1,p=1$"
func TestVerifyPasswordUsesEncodedParams(t *testing.T) // hash with TestParams verifies regardless of DefaultParams
func TestValidatePassword(t *testing.T)         // "short" → ErrPasswordTooShort; "password1234" → ErrPasswordCommon (must be in list); "alice-is-long" with username "alice-is-long" → ErrPasswordIsUsername; "correct horse battery" → nil
func TestTOTPRFC6238Vectors(t *testing.T)       // secret = base32 of "12345678901234567890"; t=59 → "287082", t=1111111109 → "081804", t=1234567890 → "005924" (6-digit SHA1 vectors)
func TestVerifyTOTPWindow(t *testing.T)         // code for step s accepted at s-1, s, s+1; rejected at s+2
func TestVerifyTOTPRejectsReplay(t *testing.T)  // ok at step s returns step s; same code with lastStep=s → false
func TestSealerRoundTrip(t *testing.T)          // Open(Seal(x)) == x; two Seals differ; tampered byte → error; different key → error
```

- [ ] **Step 2: Run** `go test ./internal/auth/...`. Expected: FAIL.
- [ ] **Step 3: Implement** with `golang.org/x/crypto/argon2.IDKey`, `crypto/hmac` + SHA-1 for HOTP (dynamic truncation per RFC 4226), and `golang.org/x/crypto/hkdf`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(auth): argon2id passwords, TOTP, secret sealing`.

---

### Task 5: Sessions, lockout and login

**Files:**
- Create: `internal/auth/session.go`, `internal/auth/lockout.go`, `internal/auth/login.go`, `internal/store/queries/users.sql`, `internal/store/queries/sessions.sql`
- Test: `internal/auth/session_test.go`, `internal/auth/lockout_test.go`, `internal/auth/login_test.go`

**Interfaces:**
- Consumes: Task 4 functions, `store.NewTestDB`, `db.Queries`.
- Produces:
  - `auth.Session{ID []byte; UserID uuid.UUID; CSRFToken string; MFAPassed bool; CreatedAt, LastSeenAt, ExpiresAt time.Time}`
  - `auth.Sessions{Now func() time.Time}` with methods:
    - `Create(ctx, q *db.Queries, userID uuid.UUID, ip netip.Addr, ua string) (token string, s auth.Session, err error)`. The token is 32 random bytes in base64url; the ID is its SHA-256; `ExpiresAt` is now + 7 d.
    - `Lookup(ctx, q, token string) (auth.Session, error)`. It returns `auth.ErrNoSession` when the session is missing, when `now - LastSeenAt >= 12h`, or when `now >= ExpiresAt`, and deletes the expired row. Otherwise it updates `last_seen_at`.
    - `Rotate(ctx, q, token string, mfaPassed bool) (newToken string, s auth.Session, err error)`, which replaces the row and keeps `ExpiresAt`.
    - `Delete(ctx, q, token string) error`
    - `DeleteForUser(ctx, q, userID uuid.UUID) error`
  - `auth.LockDuration(failures int) time.Duration`: 0 for failures under 5; `1m << (failures-5)` capped at `1h`.
  - `auth.IPLimiter`: `NewIPLimiter(now func() time.Time) *IPLimiter`, `Fail(ip netip.Addr)`, `Blocked(ip netip.Addr) bool` (at least 20 failures in a sliding 10 min).
  - `auth.Login(ctx, q, username, password string, now time.Time) (auth.User, error)`, returning `auth.ErrInvalidCredentials`, `auth.ErrLocked` (with `auth.LockedError{Until time.Time}`) or `auth.ErrDisabled`. A wrong password increments `failed_logins` and sets `locked_until = now + LockDuration`. A success resets both. An unknown username runs `VerifyPassword` against a fixed dummy hash.
  - `auth.User{ID uuid.UUID; Username, DisplayName, Email, Role string; TOTPEnrolled, TOTPRequired bool; Status string}`

- [ ] **Step 1: Write failing tests.**

```go
func TestSessionCreateLookup(t *testing.T)      // Lookup(token) returns same UserID and CSRFToken; DB row id != token bytes
func TestSessionIdleBoundary(t *testing.T)      // clock +11h59m → ok; then from that last-seen +12h exactly → ErrNoSession
func TestSessionAbsoluteExpiry(t *testing.T)    // touch every 11h for 7d → ErrNoSession at 7d
func TestSessionRotate(t *testing.T)            // old token → ErrNoSession; new token MFAPassed true; ExpiresAt unchanged
func TestLockDuration(t *testing.T)             // 4→0, 5→1m, 6→2m, 7→4m, 11→1h (64m capped), 20→1h
func TestIPLimiter(t *testing.T)                // 19 fails → not blocked; 20th → blocked; +10m1s → not blocked
func TestLoginSuccessResetsFailures(t *testing.T)
func TestLoginLocksAfterFive(t *testing.T)      // 5 wrong → 6th attempt with right pw returns ErrLocked until now+1m
func TestLoginUnknownUserSameError(t *testing.T) // errors.Is(err, ErrInvalidCredentials) for both unknown user and wrong pw
func TestLoginDisabledUser(t *testing.T)        // ErrDisabled only after a correct password
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** sqlc queries: `CreateUser`, `GetUserByUsername`, `GetUserByID`, `RecordLoginFailure`, `ResetLoginFailures`, `InsertSession`, `GetSession`, `TouchSession`, `DeleteSession`, `DeleteUserSessions`, `CountActiveOwners`, `SetTOTP`, `SetTOTPLastStep`. Tests create users through `db.CreateUser` with hashes from `auth.TestParams`.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(auth): sessions, lockout and login`.

---

### Task 6: Connect links, config string, server checks

**Files:**
- Create: `internal/connect/link.go`, `internal/connect/config.go`, `internal/servers/check.go`
- Test: `internal/connect/connect_test.go`, `internal/servers/check_test.go`

**Interfaces:**
- Consumes: `rendezvous.QueryOnline`.
- Produces:
  - `connect.Link(rustdeskID, action string, relay bool) (url string, err error)`. Actions are `connect`, `file-transfer`, `port-forward` and `terminal`. `connect` gives `rustdesk://<id>`, and the others give `rustdesk://<action>/<id>`; relay appends `/r`. Unknown actions and IDs outside `^[A-Za-z0-9_-]{3,64}$` return `connect.ErrInvalid`.
  - `connect.Command(rustdeskID, action string, relay bool) (string, error)` gives `rustdesk --<action> <id>`, with `<id>/r` for relay.
  - `connect.ClientConfig{Host, Relay, API, Key string}`, JSON tags `host`, `relay`, `api`, `key`.
  - `connect.ConfigString(c connect.ClientConfig) string` is the reversed `base64.RawURLEncoding` of the JSON. `connect.DecodeConfigString(s string) (connect.ClientConfig, error)` is its inverse.
  - `connect.InstallSnippets(c connect.ClientConfig) map[string]string`, with keys `windows`, `macos` and `linux`. Each imports the config into an installed client with admin rights: `& "$env:ProgramFiles\RustDesk\rustdesk.exe" --config <s>` (PowerShell as Administrator), `sudo /Applications/RustDesk.app/Contents/MacOS/RustDesk --config <s>`, and `sudo rustdesk --config <s>` (verified: `--config` in src/core_main.rs, which requires an installed client and root or admin)
  - `connect.APIURL(idHost, clientListenAddr string) string` gives `http://<host>:21114`. A non-default listen port replaces 21114. A port on `idHost` is dropped from the API URL (the API host is the ID host).
  - `servers.Check{Name string; OK bool; Detail string}`
  - `servers.Run(ctx context.Context, idHost, relayHost, hbbsAddr string, dial func(ctx context.Context, network, addr string) (net.Conn, error)) []servers.Check`. It dials `idHost` on TCP 21116 (or the host's own port), then `relayHost` on 21117 (or its own port). If `hbbsAddr` is not empty it runs `QueryOnline(ctx, hbbsAddr, ["rdadmin-probe"])`, where any decodable reply is OK. Each step gets a 3 s timeout.

- [ ] **Step 1: Write failing tests.**

```go
func TestLink(t *testing.T)                     // ("123456789","connect",false) → "rustdesk://123456789"; ("123456789","file-transfer",true) → "rustdesk://file-transfer/123456789/r"; ("1;rm","connect",false) → ErrInvalid; ("123","rdp",false) → ErrInvalid
func TestCommand(t *testing.T)                  // ("123456789","terminal",true) → "rustdesk --terminal 123456789/r"
func TestConfigStringRoundTrip(t *testing.T)    // decode(encode(c)) == c; encoded has no '=' and is the reverse of RawURLEncoding(json)
func TestConfigStringKnownValue(t *testing.T)   // ClientConfig{Host:"h",Relay:"r",API:"a",Key:"k"} → reverse of base64url(`{"host":"h","relay":"r","api":"a","key":"k"}`)
func TestInstallSnippetsContainConfig(t *testing.T) // all three snippets contain ConfigString(c) and "--config"
func TestAPIURL(t *testing.T)                   // ("rd.example.com",":21114") → "http://rd.example.com:21114"; ("rd.example.com:21116",":9000") → "http://rd.example.com:9000"
func TestRunChecks(t *testing.T)                // dial stub: 21116 ok, 21117 refused → [{id-server,true},{relay,false,…}]; hbbsAddr "" → 2 checks
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: connect links, client config string, server checks`.

---

### Task 7: Devices: enrollment and identity

**Files:**
- Create: `internal/devices/service.go`, `internal/store/queries/devices.sql`, `internal/store/queries/servers.sql`
- Test: `internal/devices/service_test.go`

**Interfaces:**
- Consumes: `wire.HeartbeatRequest`, `wire.HeartbeatResponse`, `wire.SysinfoRequest`, `audit.Record`, `store.Tx`, `store.NewTestDB`, and Task 8's `*devices.Tracker` (only `Beat`; Task 7 defines the interface `Beater interface{ Beat(rustdeskID string, conns []int32) }` so it does not depend on Task 8).
- Produces:
  - `devices.Service{Pool *pgxpool.Pool; Beats devices.Beater; MaxPending int; Now func() time.Time}`
  - `(*Service).Heartbeat(ctx, serverID uuid.UUID, hb wire.HeartbeatRequest, ip netip.Addr) (wire.HeartbeatResponse, error)`
  - `(*Service).Sysinfo(ctx, serverID uuid.UUID, s wire.SysinfoRequest, ip netip.Addr) error`
  - states `devices.StatePending|StateApproved|StateRejected|StateArchived` (strings matching the DB)
  - audit actions `device.enrolled`, `device.enroll_dropped`, `device.uuid_mismatch`

Behavior follows the spec's client API table exactly. Enrollment is `INSERT … ON CONFLICT (server_id, rustdesk_id) DO NOTHING RETURNING id`; only the inserting call writes `device.enrolled`. The pending cap is checked with `SELECT count(*) … WHERE state='pending'` in the same transaction. The `enroll_dropped` throttle is an in-memory last-written time, at most one per 10 min. A mismatch alert is upserted against the partial unique index, and `device.uuid_mismatch` is audited only when a new alert row was created.

- [ ] **Step 1: Write failing tests** (a test server row is created first).

```go
func TestUnknownDeviceEnrollsPending(t *testing.T)   // Heartbeat → resp.Sysinfo true; one device state pending; one audit device.enrolled
func TestSysinfoFirstAlsoEnrolls(t *testing.T)       // Sysinfo before any heartbeat → device pending with hostname stored
func TestKnownDeviceStoresSysinfo(t *testing.T)      // Sysinfo then Heartbeat → resp {} (Sysinfo false); hostname, os, client_version, presets stored
func TestUUIDMismatchChangesNothing(t *testing.T)    // enroll uuid A; heartbeat+sysinfo with uuid B and hostname "evil" → hostname unchanged; one open alert; one device.uuid_mismatch audit even after 3 more mismatches
func TestRejectedAndArchivedIgnored(t *testing.T)    // set state rejected → Heartbeat {} and Beater not called
func TestPendingCap(t *testing.T)                    // MaxPending 2: 3 unknown devices → 2 rows; 1 device.enroll_dropped audit; 4th unknown → still 1 dropped audit
func TestConcurrentEnrollmentCreatesOneDevice(t *testing.T) // 20 goroutines Heartbeat/Sysinfo same id → 1 row, 1 device.enrolled, no errors
func TestApprovedHeartbeatBeats(t *testing.T)        // approved device heartbeat with conns [3] → fake Beater got ("id",[3])
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Pending devices also call `Beats.Beat`, so the approver can see them online. `presets` stores `SysinfoRequest.Presets` as jsonb.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(devices): enrollment queue and uuid pinning`.

---

### Task 8: Online tracker, flush and hbbs probe

**Files:**
- Create: `internal/devices/tracker.go`
- Test: `internal/devices/tracker_test.go`

**Interfaces:**
- Consumes: `store.Tx`, `db.Queries` (`UpdateLastSeen(ctx, db.UpdateLastSeenParams{ServerID uuid.UUID; RustdeskIds []string; SeenAts []time.Time})`, implemented with `unnest`), `rendezvous.QueryOnline` (injected).
- Produces:
  - `devices.NewTracker(now func() time.Time) *Tracker`
  - `(*Tracker).Beat(rustdeskID string, conns []int32)`, which satisfies `Beater`
  - `(*Tracker).Online(rustdeskID string) bool`
  - `(*Tracker).Conns(rustdeskID string) []int32`
  - `(*Tracker).MarkOnline(ids []string)`, which records an hbbs-sourced presence
  - `(*Tracker).Stale(ids []string) []string`, the IDs not online
  - `(*Tracker).Flush(ctx, pool *pgxpool.Pool, serverID uuid.UUID) (int, error)`, which writes only `last_seen_at` values changed since the last flush and returns how many it wrote
  - `(*Tracker).Run(ctx, pool, serverID uuid.UUID, approved func(ctx context.Context) ([]string, error), query func(ctx context.Context, ids []string) (map[string]bool, error))`, which flushes every 30 s and probes every 60 s, in batches of 1000, only when `query != nil`, and flushes once more when ctx ends
  - constants `devices.OnlineWindow = 45 * time.Second`, `devices.FlushEvery = 30 * time.Second`, `devices.ProbeEvery = 60 * time.Second`, `devices.ProbeBatch = 1000`

- [ ] **Step 1: Write failing tests** (fake clock).

```go
func TestTrackerOnlineWindow(t *testing.T)     // Beat at t0 → Online at t0+44s, offline at t0+45s
func TestTrackerConns(t *testing.T)            // Beat with [1,2] → Conns [1,2]; Beat with nil → Conns empty
func TestTrackerMarkOnline(t *testing.T)       // MarkOnline(["x"]) → Online("x") true for 45s; Stale(["x","y"]) == ["y"]
func TestTrackerFlushWritesChanged(t *testing.T) // Beat a,b; Flush → 2 and last_seen_at set for a,b; Beat a; Flush → 1; Flush → 0
func TestTrackerProbeBatches(t *testing.T)     // approved 2500 ids, none beating; one probe cycle calls query 3 times with sizes 1000,1000,500
func TestTrackerRunFlushesOnStop(t *testing.T) // Beat, cancel ctx → last_seen_at written
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Use a mutex-guarded map, with `Run` driven by injectable tickers (`tick func(d time.Duration) <-chan time.Time`, defaulting to `time.Tick`). The probe calls `query` with `Stale(approved)`, and each true result goes to `MarkOnline`. Query errors are logged and skipped.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(devices): online tracker with batched flush and hbbs probe`.

---

### Task 9: Client listener

**Files:**
- Create: `internal/httpx/clientip.go`, `internal/httpx/ratelimit.go`, `internal/clientapi/handler.go`
- Delete: `internal/server/` (Phase 0 placeholder; its `/healthz` and JSON 404 behavior move here)
- Test: `internal/httpx/httpx_test.go`, `internal/clientapi/handler_test.go`

**Interfaces:**
- Consumes: `devices.Service`, `wire.*`, `sim.Run`.
- Produces:
  - `httpx.ClientIP(r *http.Request, trusted []netip.Prefix) netip.Addr`, which uses the rightmost `X-Forwarded-For` entry not inside `trusted`, only when the peer is trusted
  - `httpx.RateLimit(rps float64, burst int, key func(*http.Request) netip.Addr, onLimit http.HandlerFunc) func(http.Handler) http.Handler`, per-key `rate.Limiter` with idle keys evicted after 10 min
  - `clientapi.Deps{Devices *devices.Service; Setup clientapi.SetupState; Trusted []netip.Prefix}`, where `clientapi.SetupState interface{ ServerID() (uuid.UUID, bool) }` returns false until setup is complete
  - `clientapi.Routes(d clientapi.Deps) chi.Router`, mounted at `/` and serving `POST /api/heartbeat`, `POST /api/sysinfo`, `GET /healthz`, with a JSON 404 for the rest of `/api/`

- [ ] **Step 1: Write failing tests.**

```go
func TestClientIPUntrustedPeerIgnoresXFF(t *testing.T)  // peer 203.0.113.9, XFF "1.2.3.4" → 203.0.113.9
func TestClientIPTrustedPeer(t *testing.T)              // trusted 10.0.0.0/8, peer 10.0.0.2, XFF "1.2.3.4, 10.0.0.3" → 1.2.3.4
func TestRateLimit(t *testing.T)                        // rps 1 burst 2: 3 quick requests → 200,200,429
func TestHeartbeatBeforeSetup(t *testing.T)             // SetupState false → 200 "{}", no device row
func TestSysinfoBeforeSetup(t *testing.T)               // → "SYSINFO_UPDATED"
func TestHeartbeatBadBody(t *testing.T)                 // "{" → 400 {"error":"bad request"}; {"id":""} → 400
func TestBodyLimit(t *testing.T)                        // 65 KiB → 413 {"error":"body too large"}
func TestDerivedFixturesReplay(t *testing.T)            // heartbeat.json, heartbeat-with-conns.json, sysinfo.json bodies → 200; sysinfo reply text "SYSINFO_UPDATED"
func TestSimulatorEnrollsPending(t *testing.T)          // httptest server with Routes; sim.Run 3 devices 50ms for 300ms → Errors 0; 3 pending rows
func TestUnknownClientPath404(t *testing.T)             // POST /api/audit/conn → 404 {"error":"not found"}
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** The middleware order is: request body limit (64 KiB via `http.MaxBytesReader`), then rate limit (20/40 keyed by `ClientIP`), then the handlers. Bodies are read whatever the Content-Type.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(clientapi): client listener with enrollment, limits and real-IP handling`.

---

### Task 10: Admin HTTP foundation, auth endpoints, setup

**Files:**
- Create: `internal/setup/guard.go`, `internal/setup/service.go`, `internal/adminapi/{router.go,middleware.go,errors.go,auth.go,setup.go}`, `internal/adminapi/openapi.yaml` (auth and setup paths only; Task 11 adds the rest)
- Test: `internal/setup/setup_test.go`, `internal/adminapi/auth_test.go`, `internal/adminapi/setup_test.go`, `internal/adminapi/middleware_test.go`

**Interfaces:**
- Consumes: Tasks 3–6, `config.Config`.
- Produces:
  - `setup.NewGuard(now func() time.Time) (token string, g *setup.Guard)`, `(*Guard).Valid(token string) bool`. Constant-time comparison of SHA-256 digests; valid for 24 h.
  - `setup.Service{Pool; Sealer *auth.Sealer; Params auth.Params; Now func() time.Time}` with methods:
    - `Complete(ctx) (bool, error)`
    - `ServerID(ctx) (uuid.UUID, bool, error)`
    - `CreateOwner(ctx, username, password, displayName, email string) (uuid.UUID, error)`
    - `BeginOwnerTOTP(ctx) (secret, url string, err error)`
    - `VerifyOwnerTOTP(ctx, code string) error`
    - `SaveServer(ctx, name, idHost, relayHost, publicKey string) (uuid.UUID, error)`
    - `Finish(ctx, ip netip.Addr) error`, which needs a verified owner TOTP and a server, and returns `setup.ErrIncomplete` otherwise
  - `adminapi.Deps{Cfg config.Config; Pool *pgxpool.Pool; Sessions *auth.Sessions; IPLimiter *auth.IPLimiter; Sealer *auth.Sealer; Params auth.Params; Setup *setup.Service; Guard *setup.Guard; Devices *devices.Service; Tracker *devices.Tracker; ClientRoutes chi.Router; Now func() time.Time; Dial func(ctx context.Context, network, addr string) (net.Conn, error); QueryOnline func(ctx context.Context, addr string, ids []string) (map[string]bool, error)}`
  - `adminapi.New(d adminapi.Deps) http.Handler`
  - `adminapi.writeError(w, status int, code, msg string)`
  - context helpers `adminapi.userFrom(ctx) auth.User` and `adminapi.sessionFrom(ctx) auth.Session`

Middleware order (all admin routes): request ID → security headers (spec list; HSTS unless DevInsecure) → recover (500 `internal` with request_id) → session loader (cookie → `Sessions.Lookup` → user; sets ctx) → CSRF on non-GET/HEAD (`X-CSRF-Token` == session CSRF, and Origin, or failing that Referer, matches `PUBLIC_URL` origin) → per-route `requireAuth`, `requireMFA`, `requireRole("owner")`. Setup routes use the guard instead of a session, still with the Origin check.

Endpoints:
- the spec's auth and setup endpoints;
- `POST /auth/login` returns `{"mfa_required": bool, "csrf_token": "…"}`;
- `GET /auth/me` returns `{user, mfa_passed, totp_enrolled, csrf_token}`;
- `POST /setup/server` saves first, then runs `servers.Run(ctx, idHost, relayHost, Cfg.HBBSAddr, Deps.Dial)` and returns `{saved: true, server_id, checks}`.
- `POST /setup/complete` returns `{client_config: {config_string, deep_link, api, host, relay, key, install}}`, where `install` comes from `connect.InstallSnippets`. `GET /admin/api/v1/server/client-config` returns the same object after setup.

- [ ] **Step 1: Write failing tests** (httptest with a real test DB; `auth.TestParams`; fixed clock).

```go
func TestSetupTokenRequired(t *testing.T)           // POST /setup/owner without/with wrong X-Setup-Token → 401
func TestSetupTokenExpires(t *testing.T)            // clock +24h → 401
func TestSetupFlow(t *testing.T)                    // owner → totp → verify (code from secret) → server → complete → 200 with client_config; config_string decodes to the saved hosts and key; then any /setup route → 404
func TestSetupRejectsWeakPassword(t *testing.T)     // "password1234" → 400 code "weak_password"
func TestSetupCompleteNeedsTOTP(t *testing.T)       // complete before verify → 409 "incomplete"
func TestSetupServerRejectsBadKey(t *testing.T)     // public_key "abc" → 400 "invalid_key"
func TestLoginTOTPFlow(t *testing.T)                // login → mfa_required true; /devices → 403 "mfa_required"; /auth/totp good code → 200; cookie rotated
func TestCookieFlags(t *testing.T)                  // Set-Cookie name __Host-rdadmin_session, Secure, HttpOnly, SameSite=Strict, Path=/
func TestCSRFRequired(t *testing.T)                 // POST /auth/logout without header → 403 "csrf"; wrong Origin → 403 "csrf"
func TestLoginLockoutResponse(t *testing.T)         // 5 wrong → 6th → 423 code "locked"; 20 wrong across users from one IP → 429
func TestSecurityHeaders(t *testing.T)              // CSP, nosniff, no-referrer, COOP, HSTS present; HSTS absent with DevInsecure
func TestInternalErrorHasRequestID(t *testing.T)    // handler panics → 500 {"error":{"code":"internal",…,"request_id":<non-empty>}}
func TestTOTPRequiredUserLimited(t *testing.T)      // user with totp_required and no secret: /devices → 403 "totp_enroll_required"; /auth/totp/enroll → 200
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Status codes: 400 `bad_request`, `weak_password` and `invalid_key`; 401 `unauthenticated`; 403 `csrf`, `mfa_required`, `totp_enroll_required` and `forbidden`; 404 `not_found`; 409 `incomplete`, `last_owner`, `cycle` and `not_empty`; 423 `locked`; 429 `rate_limited`; 500 `internal`. Every state change audits: `setup.owner_created`, `setup.server_saved`, `setup.completed`, `auth.login`, `auth.login_failed`, `auth.logout`, `auth.password_changed`, `auth.totp_enrolled`. TOTP verification stores `totp_last_step`.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(adminapi): setup wizard, auth endpoints and security middleware`.

---

### Task 11: Admin resources: devices, groups, tags, connect, users, server, audit

**Files:**
- Create: `internal/devices/groups.go`, `internal/devices/tags.go`, `internal/adminapi/{devices.go,groups.go,tags.go,users.go,server.go,audit.go}`, `internal/store/queries/{groups.sql,tags.sql}`
- Modify: `internal/devices/service.go` (admin methods), `internal/adminapi/openapi.yaml`, `internal/adminapi/router.go`
- Test: `internal/devices/admin_test.go`, `internal/adminapi/resources_test.go`, `internal/adminapi/openapi_test.go`

**Interfaces:**
- Consumes: Tasks 3, 5, 6, 7, 8, 10.
- Produces (devices package, all audited, with `devices.Actor{UserID uuid.UUID; IP netip.Addr}`):
  - `(*Service).List(ctx, f devices.Filter, online func(string) bool) ([]devices.Device, string, error)`, where `Filter{State string; Online *bool; TagID, GroupID *uuid.UUID; OS, Q string; Limit int; Cursor string}`. `Q` is a case-insensitive match on rustdesk_id, alias, hostname or username. `Online` filters after the query using the tracker.
  - `(*Service).Get(ctx, id uuid.UUID) (devices.Device, error)`, where `Device` includes `Tags []devices.Tag` and `OpenAlerts []devices.Alert`
  - `(*Service).Update(ctx, a devices.Actor, id uuid.UUID, p devices.Patch) (devices.Device, error)`, where `Patch{Alias, Note *string; GroupID **uuid.UUID; TagIDs *[]uuid.UUID}`
  - `(*Service).Transition(ctx, a devices.Actor, id uuid.UUID, to string) error`. Allowed moves are pending→approved|rejected, approved→archived, rejected→approved, and archived→approved (restore). Anything else returns `devices.ErrBadTransition`, a 409 `bad_transition`. Approval sets `approved_by` and `approved_at`.
  - `(*Service).ResolveAlert(ctx, a devices.Actor, deviceID, alertID uuid.UUID, acceptNewUUID bool) error`
  - `devices.Groups` with `Tree`, `Create(ctx, a, name string, parent *uuid.UUID)`, `Rename`, `Move(ctx, a, id uuid.UUID, parent *uuid.UUID)` (returns `devices.ErrCycle`) and `Delete` (returns `devices.ErrNotEmpty` while devices or children remain)
  - `devices.Tags` with `List`, `Create(ctx, a, name string, color int64)`, `Update` and `Delete`
- HTTP: the spec's devices, groups, tags, connect, users, server and audit endpoints. List responses are `{items, next_cursor}`, and each device item includes `online` and `conns`. Audit actions: `device.approved|rejected|archived|restored|updated|connect_link|alert_resolved`, `group.*`, `tag.*`, `user.created|updated|totp_reset`, `server.updated`.

- [ ] **Step 1: Write failing tests.**

```go
func TestDeviceTransitions(t *testing.T)               // table of allowed/denied moves; approve sets approved_by
func TestDeviceListFilters(t *testing.T)               // state, tag, group, q, online (tracker fake) each narrow results; pagination by cursor
func TestUpdateDeviceTags(t *testing.T)                // TagIDs replace set; audit device.updated with before/after
func TestResolveAlertAcceptsNewUUID(t *testing.T)      // mismatch alert → accept → device.uuid = seen_uuid; heartbeat with new uuid now updates hostname
func TestMoveGroupUnderDescendantRefused(t *testing.T) // a→b→c; Move(a, parent=c) → ErrCycle; HTTP 409 "cycle"
func TestDeleteGroupNotEmpty(t *testing.T)             // group with device → 409 "not_empty"
func TestConnectEndpoint(t *testing.T)                 // approved → {url:"rustdesk://<id>",command:"rustdesk --connect <id>",id} + audit device.connect_link; pending → 404 "not_found"
func TestCannotRemoveLastOwner(t *testing.T)           // PATCH only owner role→admin or status→disabled → 409 "last_owner"
func TestAdminCannotManageUsers(t *testing.T)          // admin role → POST /users → 403 "forbidden"; PATCH /server → 403
func TestDisableUserEndsSessions(t *testing.T)         // disable → that user's next request 401
func TestAuditEndpointFilters(t *testing.T)            // action filter + cursor via HTTP
func TestOpenAPICoversRoutes(t *testing.T)             // chi.Walk all /admin/api/v1 and /setup routes; each method+path present in openapi.yaml (path params normalized {id})
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Cycle detection uses a recursive CTE that walks up from the proposed parent. The last-owner check runs `CountActiveOwners` with `FOR UPDATE` on owner rows inside the change's transaction. Disabling a user calls `Sessions.DeleteForUser` in the same transaction.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(adminapi): devices, groups, tags, connect, users, server and audit endpoints`.

---

### Task 12: Serve wiring and the Phase 1a gate

**Files:**
- Modify: `cmd/rdadmin/main.go`
- Create: `internal/app/app.go`, `internal/e2e/gate_test.go`
- Modify: `README.md` (create, short: what it is, `deploy/compose.yml` quick start, env table), `docs/lab.md` (`LISTEN_ADDR` → `CLIENT_LISTEN_ADDR`)

**Interfaces:**
- Consumes: everything above.
- Produces: `app.New(ctx context.Context, cfg config.Config, log *slog.Logger) (*app.App, error)` (opens the pool, migrates, builds the services, issues and logs a setup token when setup is incomplete, and starts the tracker); `(*App).ClientHandler() http.Handler`; `(*App).AdminHandler() http.Handler`; `(*App).Run(ctx) error` (both `http.Server`s with the spec's timeouts, graceful shutdown with 10 s, a final tracker flush); `(*App).SetupToken() string` (tests only; empty after setup).

- [ ] **Step 1: Write the failing gate test** in `internal/e2e/gate_test.go`, using a real test DB, `app.New` with `DevInsecure` and `httptest` servers for both handlers, a cookie jar, and a CSRF header from login.

```go
func TestPhase1aGate(t *testing.T) {
	// 1. setup via API using SetupToken(): owner (+TOTP), server, complete
	// 2. sim.Run 3 devices against client server, 50ms interval, 300ms
	// 3. GET /admin/api/v1/devices?state=pending → 3 items
	// 4. approve the first; GET /devices/{id} → state approved, online true
	// 5. GET /devices/{id}/connect → url "rustdesk://100000000"
	// 6. GET /audit → contains setup.completed, device.enrolled (×3), device.approved, device.connect_link
}
func TestAdminRefusesHTTPPublicURL(t *testing.T) // app.New with http PUBLIC_URL and DevInsecure false → error contains "https"
```

- [ ] **Step 2: Run** `REQUIRE_DB=1 go test ./internal/e2e/...`. Expected: FAIL.
- [ ] **Step 3: Implement.** `main.go serve` loads the config, builds `slog.NewJSONHandler(os.Stderr)`, calls `app.New`, runs until SIGINT or SIGTERM, and exits 1 on error. In `DEV_INSECURE` mode, log a warning at startup and every 10 min. The admin handler mounts `ClientRoutes`, so clients configured with an https API URL work through the proxy.
- [ ] **Step 4: Run** `REQUIRE_DB=1 go test -race ./... && go vet ./...`. Expected: PASS.
- [ ] **Step 5: Smoke run.** `DATABASE_URL=… SECRET_KEY=$(head -c32 /dev/urandom | base64) PUBLIC_URL=http://localhost:21120 DEV_INSECURE=1 go run ./cmd/rdadmin serve` logs `setup token:`. Then `curl -s localhost:21114/healthz` returns `ok`, and `go run ./cmd/rdsim -devices 2 -duration 20s` gives errors 0.
- [ ] **Step 6: Commit** with message `feat: serve both listeners; Phase 1a end-to-end gate`.
