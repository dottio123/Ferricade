# Phase 0: Lab and Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Go repo, CI, a typed model of every RustDesk client API payload, a request recorder for lab captures, an hbbs online-status client, a device simulator, and a contract test harness. Together these make up the Phase 0 gate: recorded requests and contract tests for each client API call.

**Architecture:** One Go module with a single binary (`rdadmin`) whose subcommands are `serve` (later the product) and `record` (lab capture). Client payloads live in `internal/clientapi/wire` as plain structs. Fixtures are JSON files under `testdata/contracts/`, either derived from RustDesk 1.5.0 source or captured by the recorder, and a single harness checks both kinds against the wire types. A second binary, `rdsim`, simulates devices for tests and load.

**Tech Stack:** Go 1.23+ (CI uses 1.24), chi v5, google.golang.org/protobuf/encoding/protowire, GitHub Actions. No frontend, database, or OIDC in this phase.

**Spec:** "RustDesk Admin WebUI: Implementation Plan", sections *RustDesk integration*, *Roadmap*, and *Findings from RustDesk 1.5.0 source*.

## Global Constraints

- Module path `github.com/dottio123/rustdesk-webui`; `rdadmin` is a working binary name, renamed with one search-and-replace once the project name is chosen.
- `go 1.23` in go.mod; must build with `CGO_ENABLED=0`.
- No code copied from other RustDesk admin projects. Protocol facts come only from rustdesk/rustdesk tag `1.5.0`, rustdesk/rustdesk-server, and rustdesk/hbb_common.
- Pinned client version for derived fixtures: `1.5.0`.
- Client API error shape: `{"error": "<message>"}` with HTTP 200 or 4xx; the client reads `error` before it checks the status code.
- Request bodies must be parsed whatever the `Content-Type` header says. `POST /api/login` is sent with no `Content-Type`.
- Every JSON decode of a client payload must tolerate unknown fields (no `DisallowUnknownFields`).
- Captured fixtures are committed to git, so the recorder must redact `password`, `address_book_password`, `secret`, `tfaCode`, `verificationCode`, and the `Authorization` header before writing anything to disk.
- hbbs online query: TCP to port `21115` (ID port − 1), with `RendezvousMessage.online_request` = field 23 and `online_response` = field 24; a peer is online if it registered within 30 000 ms.

## Review Focus

1. **Newer client adds fields:** decoding a payload with extra keys succeeds, and the contract harness reports the extra keys as findings rather than failing. Tested in Task 2 (`TestDecodeToleratesUnknownFields`) and Task 6.
2. **Secrets in captures:** a recorded `/api/login` with a password and a Bearer header writes `[redacted]` for both. Tested in Task 3 (`TestRecorderRedactsSecrets`).
3. **Login with no Content-Type:** the recorder captures the body of a POST that has no `Content-Type` header. Tested in Task 3 (`TestRecorderParsesBodyWithoutContentType`).
4. **Frame header boundaries:** payload lengths 63/64, 16383/16384, and 4194303/4194304 round-trip, and a header announcing more than the max size is rejected without allocating it. Tested in Task 4 (`TestFrameBoundaries`, `TestReadFrameRejectsOversize`).
5. **hbbs never answers:** `QueryOnline` against a listener that accepts and stays silent returns `context.DeadlineExceeded` within the caller's deadline instead of hanging. With 9 IDs (more than one byte of bits), every ID maps to the right bit. Tested in Task 4 (`TestQueryOnlineTimeout`, `TestDecodeOnlineResponseNineIDs`).

---

## File Structure

```
go.mod, go.sum, Makefile
.github/workflows/ci.yml
cmd/rdadmin/main.go                  subcommands: serve, record
cmd/rdsim/main.go                    device simulator CLI
internal/config/config.go            env → Config, validation
internal/server/server.go            chi router, /healthz
internal/clientapi/wire/*.go         payload structs, one file per area
internal/clientapi/recorder/         capture handler + redaction
internal/rendezvous/frame.go         hbb_common BytesCodec framing
internal/rendezvous/online.go        OnlineRequest/Response + QueryOnline
internal/sim/sim.go                  simulated device loop
internal/contract/                   Fixture type, loader, checker, test
testdata/contracts/derived-1.5.0/    fixtures from source reading
testdata/contracts/captured/         fixtures from the lab (empty + README)
deploy/lab/docker-compose.yml        hbbs + hbbr + recorder
docs/lab.md                          capture runbook
```

---

### Task 1: Module skeleton, config, health endpoint, CI

**Files:**
- Create: `go.mod`, `Makefile`, `.github/workflows/ci.yml`, `cmd/rdadmin/main.go`, `internal/config/config.go`, `internal/server/server.go`
- Test: `internal/config/config_test.go`, `internal/server/server_test.go`

**Interfaces:**
- Produces: `config.Load(getenv func(string) string) (config.Config, error)`; `config.Config{ListenAddr string; PublicURL *url.URL; TrustedProxies []netip.Prefix}`; `server.New(cfg config.Config) http.Handler`.

- [ ] **Step 1: Write failing config tests**

```go
func TestLoadDefaults(t *testing.T) {
	c, err := config.Load(env(map[string]string{"PUBLIC_URL": "https://admin.example.com"}))
	require.NoError(t, err)
	assert.Equal(t, ":8080", c.ListenAddr)
	assert.Equal(t, "https://admin.example.com", c.PublicURL.String())
	assert.Empty(t, c.TrustedProxies)
}
func TestLoadRequiresPublicURL(t *testing.T)            // err contains "PUBLIC_URL"
func TestLoadTrimsTrailingSlash(t *testing.T)           // "https://a.example.com/" → "https://a.example.com"
func TestLoadRejectsHTTPS21114(t *testing.T)            // "https://a.example.com:21114" → err contains "21114"
func TestLoadParsesTrustedProxies(t *testing.T)         // "10.0.0.0/8, 192.168.1.1/32" → 2 prefixes; "nope" → err
```

`env` is a test helper that turns a map into a `func(string) string`. The 21114 rule exists because the client strips `:21114` from https API URLs (`get_api_server`, src/common.rs), so such a URL would never reach us.

- [ ] **Step 2: Run** `go test ./internal/config/...`. Expected: FAIL, package does not exist.

- [ ] **Step 3: Implement `config.Load`**. Env vars: `LISTEN_ADDR` (default `:8080`), `PUBLIC_URL` (required, scheme http or https), `TRUSTED_PROXIES` (comma-separated CIDRs, spaces trimmed, parsed with `netip.ParsePrefix`).

- [ ] **Step 4: Write a failing server test.** `TestHealthz`: `GET /healthz` returns 200 with body `ok`. `TestUnknownAPIPathIsJSON404`: `GET /api/nope` returns 404 with body `{"error":"not found"}`.

- [ ] **Step 5: Implement `server.New`** with chi: mount `/healthz`, and route a `NotFound` handler under `/api/` that writes the JSON error. Then `cmd/rdadmin/main.go`: `rdadmin serve` loads the config and calls `http.ListenAndServe`; any unknown subcommand prints usage and exits 2.

- [ ] **Step 6: Run** `go test ./... && go vet ./...`. Expected: PASS.

- [ ] **Step 7: Add CI and Makefile.** `ci.yml` runs on push and pull_request with `actions/setup-go` at Go `1.24.x`, then `go vet ./...`, `go test -race ./...`, and `CGO_ENABLED=0 go build ./cmd/...`. Makefile targets: `test`, `vet`, `build` (the same commands).

- [ ] **Step 8: Commit** with message `feat: module skeleton, config, healthz, CI`.

---

### Task 2: Client API wire types and derived fixtures

**Files:**
- Create: `internal/clientapi/wire/{device.go,auth.go,lists.go,ab.go,audit.go,errors.go}`
- Create: `testdata/contracts/derived-1.5.0/*.json` (one per call, listed below)
- Test: `internal/clientapi/wire/wire_test.go`

**Interfaces:**
- Produces (all JSON tags exactly as shown; these are the verified wire names):

```go
// device.go
type HeartbeatRequest struct { ID string `json:"id"`; UUID string `json:"uuid"`; Ver int64 `json:"ver"`; Conns []int32 `json:"conns,omitempty"`; ModifiedAt int64 `json:"modified_at"` }
type HeartbeatResponse struct { Sysinfo bool `json:"sysinfo,omitempty"`; Disconnect []int32 `json:"disconnect,omitempty"`; ModifiedAt *int64 `json:"modified_at,omitempty"`; Strategy *Strategy `json:"strategy,omitempty"` }
type Strategy struct { ConfigOptions map[string]string `json:"config_options,omitempty"`; Extra map[string]string `json:"extra,omitempty"` }
type SysinfoRequest struct { ID, UUID, Version, Hostname, OS, CPU, Memory, Username string /* tags: id uuid version hostname os cpu memory username */; Presets map[string]string `json:"-"` }
const SysinfoUpdated = "SYSINFO_UPDATED"; const IDNotFound = "ID_NOT_FOUND"
type DevicesCLIRequest struct { ID, UUID, UserName, StrategyName, AddressBookName, AddressBookTag, AddressBookAlias, AddressBookPassword, AddressBookNote, DeviceGroupName, Note, DeviceUsername, DeviceName string } // snake_case tags, all omitempty except id/uuid
func ParseSysinfo(b []byte) (SysinfoRequest, error) // known keys into fields; every key starting "preset-" into Presets

// auth.go
type DeviceInfo struct { OS string `json:"os"`; Type string `json:"type"`; Name string `json:"name"` }
type LoginRequest struct { Username, Password, ID, UUID string; AutoLogin bool `json:"autoLogin"`; Type string `json:"type"`; VerificationCode string `json:"verificationCode"`; TfaCode string `json:"tfaCode"`; Secret string `json:"secret"`; DeviceInfo DeviceInfo `json:"deviceInfo"` }
type AuthBody struct { AccessToken string `json:"access_token"`; Type string `json:"type"`; TfaType string `json:"tfa_type"`; Secret string `json:"secret"`; User UserPayload `json:"user"` }
type UserPayload struct { Name string `json:"name"`; DisplayName string `json:"display_name"`; Avatar string `json:"avatar"`; Email string `json:"email"`; Note string `json:"note"`; Status int `json:"status"`; Info UserInfo `json:"info"`; IsAdmin bool `json:"is_admin"`; ThirdAuthType string `json:"third_auth_type,omitempty"` }
type UserInfo struct { EmailVerification bool `json:"email_verification"`; EmailAlarmNotification bool `json:"email_alarm_notification"`; LoginDeviceWhitelist []json.RawMessage `json:"login_device_whitelist"`; Other map[string]string `json:"other"` }
type OIDCAuthRequest struct { Op, ID, UUID string; DeviceInfo DeviceInfo `json:"deviceInfo"`; APIDomain string `json:"apiDomain"` }
type OIDCAuthResponse struct { Code string `json:"code"`; URL string `json:"url"` }
const AuthTypeAccessToken = "access_token"; const AuthTypeEmailCheck = "email_check"; const AuthTypeTfaCheck = "tfa_check"
const OIDCPending = "No authed oidc is found"
const UserStatusDisabled, UserStatusNormal, UserStatusUnverified = 0, 1, -1
func LoginOptions(providers []string) []string // each → "oidc/<name>"

// lists.go
type Page[T any] struct { Total int `json:"total"`; Data []T `json:"data"` }
type PeerPayload struct { ID string `json:"id"`; Info PeerInfo `json:"info"`; Status int `json:"status"`; User string `json:"user"`; UserName string `json:"user_name"`; DeviceGroupName string `json:"device_group_name"`; Note string `json:"note"` }
type PeerInfo struct { Username string `json:"username"`; OS string `json:"os"`; DeviceName string `json:"device_name"` } // device_name, NOT hostname
type DeviceGroupPayload struct { Name string `json:"name"` }

// ab.go (legacy mode only in v1)
type LegacyAB struct { Data string `json:"data"`; LicensedDevices int `json:"licensed_devices,omitempty"` } // Data is JSON text of LegacyABData
type LegacyABData struct { Tags []string `json:"tags"`; Peers []ABPeer `json:"peers"`; TagColors string `json:"tag_colors"` } // TagColors is JSON text of map[string]int
type ABPeer struct { ID, Username, Hostname, Platform, Alias string; Tags []string `json:"tags"`; Hash string `json:"hash,omitempty"` }

// audit.go
type ConnAudit struct { ID, UUID string; ConnID int32 `json:"conn_id"`; SessionID uint64 `json:"session_id"`; Nonce string `json:"nonce"`; Action string `json:"action,omitempty"`; IP string `json:"ip,omitempty"`; Peer []string `json:"peer,omitempty"`; Type *int `json:"type,omitempty"`; PrimaryAuth *int `json:"primary_auth,omitempty"`; TwoFactor *int `json:"two_factor,omitempty"`; ConnAuditRef string `json:"conn_audit_ref,omitempty"` }
type FileAudit struct { ID, UUID, PeerID string /* peer_id */; ConnID int32 `json:"conn_id"`; Type int `json:"type"`; Path string `json:"path"`; IsFile bool `json:"is_file"`; Info string `json:"info"`; Nonce string `json:"nonce"` } // Info is JSON text
type AlarmAudit struct { ID, UUID string; Typ int `json:"typ"`; Info string `json:"info"`; ConnID int32 `json:"conn_id"`; Nonce string `json:"nonce"`; ConnAuditRef string `json:"conn_audit_ref,omitempty"` }
const ConnActionNew, ConnActionClose = "new", "close"

// errors.go
type ErrorBody struct { Error string `json:"error"` }
func WriteError(w http.ResponseWriter, status int, msg string)
```

- [ ] **Step 1: Write the derived fixtures.** Each file is a `contract.Fixture` (Task 6) with `"source": "derived"`, `"client_version": "1.5.0"`, and `"ref"` set to the source file and function. Files: `heartbeat.json`, `heartbeat-with-conns.json`, `sysinfo.json` (include `"preset-address-book-name"`), `login.json`, `login-response.json`, `login-options.json`, `oidc-auth.json`, `oidc-auth-query-pending.json` (response `{"error":"No authed oidc is found"}`), `oidc-auth-query-done.json`, `current-user.json`, `users-page.json`, `peers-page.json`, `device-group-page.json`, `ab-legacy-get.json`, `ab-legacy-post.json`, `audit-conn-new.json`, `audit-conn-auth.json`, `audit-conn-close.json`, `audit-file.json`, `audit-alarm.json`, `devices-cli.json`. Example:

```json
{"source":"derived","client_version":"1.5.0","ref":"src/hbbs_http/sync.rs start_hbbs_sync_async",
 "method":"POST","path":"/api/heartbeat",
 "body":{"id":"123456789","uuid":"ZmFrZS11dWlk","ver":1005000,"conns":[3],"modified_at":0},
 "response":{"disconnect":[3],"modified_at":1791300000,"strategy":{"config_options":{"enable-file-transfer":"N"}}}}
```

- [ ] **Step 2: Write failing tests.**

```go
func TestHeartbeatResponseOmitsEmpty(t *testing.T)   // json.Marshal(HeartbeatResponse{}) == "{}"
func TestHeartbeatSysinfoFlag(t *testing.T)          // HeartbeatResponse{Sysinfo:true} marshals to {"sysinfo":true}
func TestParseSysinfoPresets(t *testing.T)           // {"hostname":"pc1","preset-address-book-name":"Ops"} → Hostname "pc1", Presets["preset-address-book-name"]=="Ops"
func TestAuthBodyAlwaysHasUserInfo(t *testing.T)     // zero AuthBody marshals with "info":{...}, because the Rust client's UserPayload.info has no serde default
func TestConnAuditPeerTuple(t *testing.T)            // `"peer":["987654321","alice"]` decodes to Peer []string{"987654321","alice"}
func TestLegacyABRoundTrip(t *testing.T)             // LegacyAB.Data → LegacyABData with 1 peer, tag_colors `{"work":4280391411}`
func TestLoginOptions(t *testing.T)                  // ["authentik"] → ["oidc/authentik"]
func TestDecodeToleratesUnknownFields(t *testing.T)  // HeartbeatRequest with extra "future_field":1 decodes without error
```

- [ ] **Step 3: Run** `go test ./internal/clientapi/wire/...`. Expected: FAIL (undefined types).
- [ ] **Step 4: Implement the types.** `ParseSysinfo` unmarshals into the struct, then into `map[string]json.RawMessage`, and copies string values whose key has the prefix `preset-`.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** with message `feat: client API wire types and 1.5.0 derived fixtures`.

---

### Task 3: Lab recorder (`rdadmin record`)

**Files:**
- Create: `internal/clientapi/recorder/recorder.go`, `internal/clientapi/recorder/redact.go`
- Modify: `cmd/rdadmin/main.go` (add the `record` subcommand)
- Test: `internal/clientapi/recorder/recorder_test.go`

**Interfaces:**
- Consumes: `wire.SysinfoUpdated`, `wire.WriteError`, `contract.Fixture` (Task 6 defines it; if Task 6 has not landed yet, create `internal/contract/fixture.go` with only the struct here).
- Produces: `recorder.New(out io.Writer, clientVersion string) http.Handler` writes one `contract.Fixture` JSON per line with `"source":"captured"`. `recorder.Redact(body []byte) []byte`.

Recorder replies (the minimum that keeps a client talking):

| Request | Reply |
|---|---|
| `POST /api/heartbeat` | `{}` |
| `POST /api/sysinfo` | text `SYSINFO_UPDATED` |
| `GET /api/login-options` | `[]` |
| `POST /api/audit/{conn,file,alarm}` | `{}` |
| `POST /api/ab/personal`, `/api/ab/settings` | 404 `{"error":"not found"}` (forces legacy address book) |
| anything else | 404 `{"error":"not found"}` |

- [ ] **Step 1: Write failing tests.**

```go
func TestRecorderHeartbeat(t *testing.T)                 // reply "{}", one line written, fixture.Path=="/api/heartbeat", Body.id=="123"
func TestRecorderSysinfoText(t *testing.T)               // reply body exactly "SYSINFO_UPDATED"
func TestRecorderRedactsSecrets(t *testing.T)            // login body {"username":"a","password":"p"} + "Authorization: Bearer t" → line contains no "p\"" or "Bearer t"; both "[redacted]"
func TestRecorderParsesBodyWithoutContentType(t *testing.T) // POST /api/login, no Content-Type → fixture Body is the JSON object
func TestRecorderCapsBody(t *testing.T)                  // 2 MiB body → 413 + {"error":"body too large"}, still records path with Body null
func TestRecorderKeepsQuery(t *testing.T)                // GET /api/peers?current=1&pageSize=100 → Query{"current":"1","pageSize":"100"}
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Bodies are capped at 1 MiB with `http.MaxBytesReader`. `Redact` walks the decoded JSON recursively and replaces the values of the keys named in Global Constraints. The Authorization header is stored as `"Bearer [redacted]"`. A mutex guards concurrent writes. A non-JSON body is stored as a JSON string.
- [ ] **Step 4: Wire the CLI:** `rdadmin record --listen :21114 --out captures.jsonl --client-version <ver>`.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** with message `feat: lab recorder for client API captures`.

---

### Task 4: hbbs framing and online query

**Files:**
- Create: `internal/rendezvous/frame.go`, `internal/rendezvous/online.go`
- Test: `internal/rendezvous/frame_test.go`, `internal/rendezvous/online_test.go`

**Interfaces:**
- Produces: `WriteFrame(w io.Writer, p []byte) error`; `ReadFrame(r io.Reader, max int) ([]byte, error)`; `EncodeOnlineRequest(ids []string) []byte`; `DecodeOnlineResponse(msg []byte, ids []string) (map[string]bool, error)`; `QueryOnline(ctx context.Context, addr string, ids []string) (map[string]bool, error)`.

Framing (hbb_common `BytesCodec`): the header is 1–4 little-endian bytes holding `len<<2 | (headerLen-1)`. Use 1 byte when len ≤ 0x3F, 2 when ≤ 0x3FFF, 3 when ≤ 0x3FFFFF, and 4 when ≤ 0x3FFFFFFF. Messages are hand-encoded with `protowire`: `RendezvousMessage{23: OnlineRequest{1: id string, 2: repeated peers}}`, and the response is `RendezvousMessage{24: OnlineResponse{1: states bytes}}`. The bit for `ids[i]` is `states[i/8] & (1 << (7 - i%8))`. Hand-encoding avoids a protoc toolchain for two messages; switch to generated code when Phase 3 needs more.

- [ ] **Step 1: Write failing tests.**

```go
func TestFrameBoundaries(t *testing.T)            // lengths 0,63,64,16383,16384,4194303,4194304 round-trip; header bytes 1,1,2,2,3,3,4
func TestReadFrameRejectsOversize(t *testing.T)   // header says 1<<29, max 1<<20 → error, no 512 MiB allocation
func TestEncodeOnlineRequest(t *testing.T)        // ids ["a","b"] → protowire-decoded field 23 → field 2 values "a","b"
func TestDecodeOnlineResponseNineIDs(t *testing.T) // states {0b10100000, 0b10000000} over 9 ids → ids 0,2,8 true, rest false
func TestQueryOnlineAgainstFakeHBBS(t *testing.T) // net.Listen fake reads a frame, replies states {0x80}; QueryOnline(["x"]) == {"x":true}
func TestQueryOnlineTimeout(t *testing.T)         // fake accepts and never writes; ctx 200ms → errors.Is(err, context.DeadlineExceeded) within 1s
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `QueryOnline` dials with `net.Dialer.DialContext`, sets the connection deadline from ctx, sends one frame, reads one frame with max 1 MiB, and returns `ctx.Err()` when the deadline fired. If the response holds fewer bits than IDs, the missing IDs count as offline.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: hbbs frame codec and OnlineRequest client`.

---

### Task 5: Device simulator (`rdsim`)

**Files:**
- Create: `internal/sim/sim.go`, `cmd/rdsim/main.go`
- Test: `internal/sim/sim_test.go`

**Interfaces:**
- Consumes: `wire.HeartbeatRequest`, `wire.HeartbeatResponse`, `wire.SysinfoUpdated`.
- Produces: `sim.Options{API string; Devices int; Interval time.Duration; IDBase int; Version string}`; `sim.Run(ctx context.Context, o sim.Options) (sim.Stats, error)`; `sim.Stats{Heartbeats, Sysinfos, Errors int64; Disconnects int64; P50, P99 time.Duration}`.

Each device has ID `IDBase+i` and a stable fake UUID (base64 of `sim-<id>`). It posts sysinfo once, then reposts sysinfo whenever a heartbeat reply contains `sysinfo`. It heartbeats every `Interval`, with starts spread evenly across the first interval, and counts each `disconnect` entry it receives. Defaults: `Interval` 15s, `Version` `1.5.0`, and `Ver` 1005000 in the heartbeat (from hbb_common `get_version_number`).

- [ ] **Step 1: Write failing tests.**

```go
func TestSimSendsSysinfoThenHeartbeats(t *testing.T) // httptest server; 3 devices, Interval 50ms, run 300ms → Sysinfos==3, Heartbeats>=9, Errors==0
func TestSimResendsSysinfoOnRequest(t *testing.T)    // server replies {"sysinfo":true} once per device → Sysinfos==6
func TestSimCountsErrors(t *testing.T)               // server returns 500 → Errors>0, Run still returns nil at ctx end
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** with one goroutine per device and a shared `http.Client` with a 10s timeout. Latency percentiles come from a sorted slice at the end.
- [ ] **Step 4: Add the CLI:** `rdsim --api http://localhost:21114 --devices 1000 --interval 15s --duration 2m` prints Stats as JSON.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** with message `feat: rdsim device simulator`.

---

### Task 6: Contract harness, lab compose, capture runbook

**Files:**
- Create: `internal/contract/fixture.go`, `internal/contract/check.go`, `internal/contract/contract_test.go`
- Create: `testdata/contracts/captured/README.md`, `deploy/lab/docker-compose.yml`, `docs/lab.md`

**Interfaces:**
- Consumes: every type from Task 2.
- Produces: `contract.Fixture{Source, ClientVersion, Ref, Method, Path string; Query map[string]string; Headers map[string]string; Body json.RawMessage; Response json.RawMessage; ResponseText string}`; `contract.LoadDir(dir string) ([]Fixture, error)` reads `*.json` (one fixture per file) and `*.jsonl` (one per line); `contract.Check(f Fixture) []Finding`; `Finding{Path, Field, Kind string}` where Kind is one of `unknown-field`, `missing-field`, `type-mismatch`, `no-route`.

`Check` maps `Method`+`Path` to the request type (a route table, with `/api/audit/conn` → `ConnAudit` and so on). It decodes `Body` strictly into a scratch copy only to list unknown keys, then decodes leniently, and compares each required field from a per-type list (`id`, `uuid` for device calls) for presence. Responses are checked the same way when present. An unmapped path yields `no-route`.

- [ ] **Step 1: Write failing tests.**

```go
func TestDerivedFixturesHaveNoFindings(t *testing.T) // LoadDir("../../testdata/contracts/derived-1.5.0"), 21 fixtures, Check → no findings
func TestCapturedFixturesReport(t *testing.T)        // LoadDir(captured); findings logged with t.Log; fails only on type-mismatch or missing-field
func TestCheckReportsUnknownField(t *testing.T)      // heartbeat body + "x":1 → one Finding{Kind:"unknown-field", Field:"x"}
func TestCheckReportsNoRoute(t *testing.T)           // POST /api/brand-new → Kind "no-route"
func TestLoadDirReadsJSONL(t *testing.T)             // temp dir with 2-line .jsonl → 2 fixtures
```

- [ ] **Step 2: Run** `go test ./internal/contract/...`. Expected: FAIL.
- [ ] **Step 3: Implement `LoadDir` and `Check`.**
- [ ] **Step 4: Run** `go test ./...`. Expected: PASS. An empty `captured/` must pass too.
- [ ] **Step 5: Write the lab files.** `deploy/lab/docker-compose.yml` defines `hbbs` (`rustdesk/rustdesk-server:1.1.16`, `hbbs -r hbbr:21117`, ports 21115-21116 tcp, 21116 udp), `hbbr` (21117), and `recorder` (built from repo root, `rdadmin record --listen :21114 --out /captures/captures.jsonl --client-version ${CLIENT_VERSION}`, port 21114, volume `./captures`). `docs/lab.md` covers:
  - Point a client at the lab by setting only the ID server and key. With no API server set, the client derives `http://<host>:21114` on its own, which makes this the first thing to verify.
  - The capture checklist: sign in, open the address book, add a peer and tag, connect, transfer a file, disconnect, and fail the password 6 times to trigger an alarm.
  - Copy `captures.jsonl` into `testdata/contracts/captured/<version>-<os>.jsonl` and run `go test ./internal/contract/...`.
  - Repeat with the previous minor client version.
- [ ] **Step 6: Commit** with message `feat: contract harness and lab capture setup`.

**Phase 0 gate:** the derived fixtures pass in CI (done by this plan). After that, a person runs `docs/lab.md` with clients 1.5.0 and 1.4.x on at least Windows and one other OS, commits the captures, and the harness reports no `type-mismatch` or `missing-field`. Each `unknown-field` gets a decision recorded in the spec before Phase 1 starts.
