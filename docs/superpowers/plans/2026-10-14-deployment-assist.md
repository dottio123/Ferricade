# Deployment Assist Implementation Plan

> **For agentic workers:** this project executes plans through its orchestration flow
> (`docs/orchestration/ORCHESTRATION.md`): the Project Lead turns each task below into a task file
> (`docs/orchestration/tasks/tNN.md`), a Codex worker implements it, the Lead reviews. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Settings → Deployment page that stores one deployment profile (installer, fleet password,
client settings) and downloads unattended Windows and Linux scripts that install/update the stock
RustDesk client, point it at this server, set the fleet password and apply the chosen settings.

**Architecture:** A pure Go package `internal/deploy` (settings catalog, shell quoting, script
rendering from templates) with no database; a single-row `deployment_profile` table holding the sealed
password; three admin API endpoints in `internal/adminapi/deployment.go`; a React settings page. The
client switches and the settings catalog come from a research task against the RustDesk 1.5.0 source,
done first.

**Tech Stack:** Go 1.27, chi, pgx + sqlc, goose migrations, `text/template`, `auth.Sealer`; React 19,
TanStack Router/Query, openapi-fetch; Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-deployment-assist-design.md`

## Global Constraints

- Stock RustDesk client **1.5.0** (the tested version); nothing the stock client cannot do is offered.
- Windows and Linux scripts only; macOS shown as "coming later".
- Fleet password sealed with `SECRET_KEY` via `auth.Sealer.SealWithAAD`, AAD
  `rdadmin/deployment/fleet-password`; never in any response, log, audit detail or error.
- Owner: read, write, download. Admin: read, download. User: 403 `forbidden` on every endpoint.
- Audit actions (same transaction as the change): `deployment.profile_updated`,
  `deployment.password_set`, `deployment.password_removed`, `deployment.script_downloaded`.
- Every value inserted into a script goes through `QuotePS` or `QuoteSH`; nothing unquoted.
- Script exit codes: `0` ok, `10` not elevated, `20` download or checksum failed, `30` install
  failed, `40` configuration failed. Logs: `%ProgramData%\rdadmin\deploy.log`,
  `/var/log/rdadmin-deploy.log`.
- AGENTS.md rules apply (contract first, tests first, no generated-code edits, new migration only).

## Checkpoint results (2026-10-14; override anything below that disagrees)

Task 1 is done (`testdata/client-deploy-1.5.0/client-deploy.md`, `client-settings-catalog.json`,
11 entries). User rulings and lab results at the checkpoint:

- **Settings lock = unlock PIN.** `rustdesk --set-unlock-pin <pin>` (4-128 characters; gates the
  Security and Network panels; a local admin can reset it). A second write-only secret in the profile,
  sealed like the fleet password (AAD `rdadmin/deployment/unlock-pin`), with its own include toggle; not
  in the catalog. Audit: `deployment.pin_set`, `deployment.pin_removed`.
- **Fleet password rules:** 8-128 characters with at least one uppercase letter, one lowercase letter
  and one digit (the client UI's rules); otherwise 400 `bad_request`.
- **Windows installs with the MSI:** `msiexec.exe /i <msi> /qn /norestart`, standard exit codes. An
  existing EXE install (registry uninstall entry without MSI registration) is not touched: exit `50`.
- **Assets** (GitHub source): `https://github.com/rustdesk/rustdesk/releases/download/<ver>/` +
  `rustdesk-<ver>-x86_64.msi`, `rustdesk-<ver>-x86_64.deb`, `rustdesk-<ver>-0.x86_64.rpm`.
- **Commands:** `--config <string>`, `--password <pw>`, `--set-unlock-pin <pin>`, `--option <key>
  <value>`; installed version via `rustdesk --version` (Windows: the exe at the registry
  `InstallLocation`, default `%ProgramFiles%\RustDesk\rustdesk.exe`).
- **Read-back verification:** after each `--option`, the script reads the option back
  (`--option <key>`); a mismatch exits `40`. Commands can report success without the service taking the
  value, so the script never trusts the command alone.
- **Never pass an empty argument.** Windows PowerShell 5.1 drops empty strings to native programs; all
  values written are explicit (`Y`/`N`, named modes).
- **Lab so far:** Linux root and Windows SYSTEM (Atera) work with a user signed in; with nobody signed in
  is untested and accepted as a known risk (read-back makes such a run fail loudly with exit `40`).
- **Scripts stay basic** (user): steps and exit codes, run elevated; no RMM-specific logic.
- **Release:** **1.4.0** (1.3.0 shipped the Podman fix and create-tag).

## Review Focus

1. **Hostile passwords and values** (`'`, `"`, `$(id)`, backtick, `%PATH%`, newline, non-ASCII) must
   produce scripts that set exactly that password and execute nothing else. → Task 2 tests.
2. **`SECRET_KEY` rotated** after a password was set: GET reports `password.set: false`, the script
   renders without the password step, no 500. → Task 3 test.
3. **Setup not complete** (no server profile): `POST /deployment/script` answers 404 `not_found`, as
   `GET /server/client-config` does; GET/PUT profile still work. → Task 3 test.
4. **Installer source `url` with no URL for the requested OS**: `POST /deployment/script` answers 400
   `bad_request` naming the missing field; PUT accepts a partial set. → Task 3 test.
5. **Catalog drift**: a stored setting key that is no longer in the catalog is ignored when rendering
   and dropped on the next save; an unknown key or an invalid value in a PUT is 400. → Tasks 2 and 3.

---

### Task 1: Research the stock client's deployment switches (RustDesk 1.5.0)

Worker: Codex GPT-6 Sol, effort high. Read-only on product code.

**Files:**
- Create: `testdata/client-deploy-1.5.0/client-deploy.md`
- Create: `testdata/client-deploy-1.5.0/client-settings-catalog.json`

**Interfaces:**
- Produces: the catalog file, an array of
  `{"key": str, "label": str, "help": str, "type": "bool"|"enum", "values": [str] (enum only),
  "default": str, "os": ["windows","linux","macos"...], "lock": bool, "source": "path/file.rs:line"}`.
  `key` is the client's own option name. `lock: true` marks the settings-lock entry.
- Produces: `client-deploy.md` with one section per question below; every claim cites
  `file.rs:line` in the RustDesk 1.5.0 tag.

- [ ] **Step 1:** Fetch the source read-only: `git clone --depth 1 --branch 1.5.0
  https://github.com/rustdesk/rustdesk a local RustDesk 1.5.0 checkout` (outside the repo).
- [ ] **Step 2:** Answer, with citations: (a) Windows silent install (exe and/or MSI switches) and
  silent update; (b) Linux install per `.deb`/`.rpm` and the release asset names for 1.5.0;
  (c) `--config`, `--password`, `--option` (or equivalent) syntax, and whether each works as
  SYSTEM/root without a logged-in user and needs a service restart; (d) the settings lock: does the
  stock client have one (e.g. an unlock PIN), how a script sets it, what it locks; (e) permanent
  password rules (length, characters); (f) how to read the installed version on each OS; (g) whether
  GitHub publishes checksums for 1.5.0 assets; (h) options for approve mode, LAN discovery, direct IP
  access, and session permissions (file transfer, clipboard, audio, restart), with exact keys and
  values.
- [ ] **Step 3:** Write the catalog: only options a script can set on the stock client; each with
  its citation.
- [ ] **Step 4:** Verify: `node -e "JSON.parse(require('fs').readFileSync('testdata/client-deploy-1.5.0/client-settings-catalog.json','utf8'))"`
  exits 0; `git diff --stat origin/main...HEAD` lists only the two files.
- [ ] **Step 5:** Commit.

**Checkpoint (Lead + user):** the user reviews the catalog and the answers. The Lead updates Tasks 2-4
of this plan with the confirmed commands and option keys before writing their task files. If the
stock client has no settings lock, the user decides whether to continue without it.

### Task 2: `internal/deploy`: catalog, quoting, rendering (no database)

Worker: Codex GPT-6 Sol, effort medium. Merges on its own (no route).

**Files:**
- Create: `internal/deploy/catalog.go`, `internal/deploy/catalog.json` (copy of Task 1's catalog,
  `//go:embed`), `internal/deploy/quote.go`, `internal/deploy/render.go`,
  `internal/deploy/templates/windows.ps1.tmpl`, `internal/deploy/templates/linux.sh.tmpl`
- Test: `internal/deploy/quote_test.go`, `internal/deploy/render_test.go`,
  `internal/deploy/testdata/golden/{windows.ps1,linux.sh}`

**Interfaces:**
- Produces:
  - `type Setting struct { Key, Label, Help, Type, Default string; Values, OS []string; Lock bool }`
  - `func Catalog() []Setting` (catalog order); `func Lookup(key string) (Setting, bool)`
  - `type SettingValue struct { Include bool; Value string }`
  - `type Profile struct { InstallerSource string /* "github"|"url" */; ClientVersion string;
    URLWindows, URLDeb, URLRPM, SHA256Windows, SHA256Deb, SHA256RPM string; AllowDowngrade bool;
    Settings map[string]SettingValue }`
  - `func Validate(p Profile) error` (unknown key or value not allowed by the catalog → error naming it)
  - `func QuotePS(s string) string`, `func QuoteSH(s string) string`
  - `type Secrets struct { Password, UnlockPIN *string }` (nil = that step omitted)
  - `func Render(os string, p Profile, s Secrets, serverConfig string) ([]byte, error)`;
    `os` is `"windows"` or `"linux"`; a nil secret omits its step; keys not in the
    catalog are skipped; returns an error for any other `os`.

- [ ] **Step 1: Failing tests.** `TestQuotePS`/`TestQuoteSH` table: `a'b`, `$(id)`, backtick,
  `%PATH%`, `"x"`, newline, `ü` → round-trip through the real interpreter returns the input
  unchanged (`pwsh -NoProfile -Command "Write-Output <quoted>"`, `sh -c 'printf %s <quoted>'`; skip
  with `t.Skip` only if the interpreter is missing, and the Docker gate has `sh`).
  `TestRenderGolden` for both OS with a fixed profile (all toggles on, password `p@ss'w$rd`) against
  the golden files (`-update` flag regenerates). `TestRenderOmitsPassword` (nil password → no password
  step, golden diff). `TestRenderSkipsUnknownKeys`. `TestValidate` (unknown key, bad enum value).
  `TestRenderParses`: the `.ps1` parses with
  `[System.Management.Automation.Language.Parser]::ParseInput` (pwsh) and the `.sh` passes `bash -n`.
- [ ] **Step 2:** Run `go test ./internal/deploy/...` → FAIL (package missing).
- [ ] **Step 3:** Implement. Templates follow spec section 4 steps 1-6 with the exit codes and log
  paths from Global Constraints and the commands confirmed at the checkpoint; the password never goes
  to the log.
- [ ] **Step 4:** `go test ./internal/deploy/...`, `gofmt -l .`, `go vet ./...` → PASS / empty.
- [ ] **Step 5:** Commit.

### Task 3: Contract, data and API (one PR)

Worker: Codex GPT-6 Sol, effort medium. Security audit before merge (Codex Sol reviewer while Gemini is
out).

**Files:**
- Modify: `internal/adminapi/openapi.yaml` (paths and schemas below), then `npm run gen:api` in `web/`
- Create: `internal/store/migrations/00010_deployment_profile.sql`,
  `internal/store/queries/deployment.sql`; run `make sqlc`
- Create: `internal/deploy/store.go`; `internal/adminapi/deployment.go`
- Modify: `internal/adminapi/router.go` (GET and POST in the owner+admin group next to
  `/server/client-config`, ~line 178; PUT in the owner-only group next to `PATCH /server`, ~line 214)
- Test: `internal/deploy/store_test.go`, `internal/adminapi/deployment_test.go`

**Interfaces:**
- Consumes: Task 2's `Profile`, `Validate`, `Render`, `Catalog`; `auth.Sealer`; `connect.ConfigString`.
- Produces (contract):
  - `GET /admin/api/v1/deployment/profile` → `200 DeploymentProfile`:
    `{installer_source, client_version, url_windows, url_deb, url_rpm, sha256_windows, sha256_deb,
    sha256_rpm, allow_downgrade, settings: {<key>: {include, value}}, catalog: [DeploymentSetting],
    password: {set: bool, set_at: date-time|null, set_by: {id, display_name}|null},
    unlock_pin: {same shape as password}}` (PUT also takes write-only `unlock_pin: string|null`, 4-128)
  - `PUT /admin/api/v1/deployment/profile` (owner) body = the editable fields plus optional
    `fleet_password: string|null` (absent keep, string set, null remove) → `200 DeploymentProfile`;
    `400 bad_request`, `403 forbidden`.
  - `POST /admin/api/v1/deployment/script` body `{os: windows|linux}` → `200 text/plain` attachment
    (`rdadmin-deploy.ps1` / `rdadmin-deploy.sh`); `400 bad_request`, `403`, `404 not_found` (setup
    incomplete).
- Produces (Go): `deploy.Store{Pool, Sealer}` with `Get(ctx) (Profile, PasswordInfo, error)`,
  `Save(ctx, actor uuid.UUID, p Profile, pw PasswordChange) error` (audits in its transaction),
  `Password(ctx) (*string, error)` (nil when unset or unreadable after key rotation).

- [ ] **Step 1: Failing tests** (`REQUIRE_DB=1`): owner GET/PUT/POST ok; admin GET/POST ok, PUT 403;
  user all 403; PUT with a password then GET → `password.set` true and no password anywhere in the
  body (assert the plain value is absent from the raw response); audit rows for each action with no
  secret in details; Review Focus 2 (re-seal with another key → `set: false`, script without
  password, 200); Review Focus 3 (no server profile → 404 on POST); Review Focus 4 (source `url`, no
  `url_deb`/`url_rpm`, POST linux → 400 naming the field); Review Focus 5 (unknown key → 400; stored
  stale key dropped on save); downloaded script contains the server config string and
  `Content-Disposition` filename per OS; a `fleet_password` breaking the client's rules from Task 1 (e)
  → 400 naming the rule.
- [ ] **Step 2:** Run them → FAIL.
- [ ] **Step 3:** Contract first, then migration (single row enforced, e.g. `id boolean PRIMARY KEY
  DEFAULT true CHECK (id)`), queries, `make sqlc`, store, handlers, routes.
- [ ] **Step 4:** Docker Go gate (sqlc diff, gofmt, vet, `go test -race` with `REQUIRE_DB=1`) and
  `npm run gen:api:check` → PASS.
- [ ] **Step 5:** Commit.

### Task 4: Settings → Deployment page

Worker: Codex GPT-6 Luna, effort medium (Gemini for visual polish later if its budget allows).

**Files:**
- Create: `web/src/routes/_app/settings/deployment.tsx`, `web/src/components/settings/deployment-*.tsx`
  (installer, password, settings list, download)
- Modify: the settings navigation (where `server.tsx` and `thresholds.tsx` are linked); mock API:
  `web/src/mocks/routes/` (profile store, script download returning a fixed text) and mock operations
- Test: `web/e2e/deployment.spec.ts`, component unit tests

**Interfaces:**
- Consumes: Task 3's endpoints via the generated client.

- [ ] **Step 1: Failing e2e** (mock build): owner edits version and a toggle, saves, reloads, sees
  them; sets the password (twice, mismatch shows an error), sees "Set on …"; removes it; downloads
  Windows and Linux (download event filename `rdadmin-deploy.ps1` / `.sh`); with no password set the
  download shows the warning "No fleet password is set; the script will not set one" first; admin
  sees the page read-only except downloads; a User does not see the page and `/settings/deployment`
  shows the usual not-allowed state; macOS button disabled "coming later".
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with existing settings-page components and patterns.
- [ ] **Step 4:** `npm run typecheck`, `lint`, `test`, `build`; Playwright for the new spec plus
  `a11y.spec.ts` and `user-role.spec.ts` (config default workers) → PASS.
- [ ] **Step 5:** Commit.

### Task 5: Lab gate and release 1.3.0

- [ ] **Step 1:** User runs the Windows script on a real Windows machine (RMM or GPO if possible) and
  the Linux script on a real Linux machine against the work server. Pass: the client installs or
  updates, registers in rdadmin, accepts the fleet password, shows the chosen settings and the lock;
  a second run changes nothing and exits 0; a non-elevated run exits 10.
- [ ] **Step 2:** Release task (changelog `1.4.0`, `.env.example`), tag, `scripts/release-image.sh`.
