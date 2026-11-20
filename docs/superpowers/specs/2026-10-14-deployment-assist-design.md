# Deployment Assist: design

Status: approved in conversation by the user on 2026-10-14 (Project Lead 7). This document is the
reviewed form of that design. Implementation starts only after the user approves this file.

## Purpose

Admins roll the stock RustDesk client out to many machines at once. Today rdadmin offers a one-line
`--config` command per OS. Deployment Assist turns that into complete, unattended deployment scripts
that install or update the client, point it at this server, set the fleet password and apply chosen
client settings, so an RMM/MDM or a Group Policy script can deploy and keep machines consistent.

## Requirements (from the user)

- Scripts run **unattended**: pushed by an RMM/MDM, or as a Group Policy startup/login script. No
  prompts; safe to run again and again; meaningful exit codes.
- Platforms: **Windows and Linux** in the first version. **macOS** is needed too and follows later; the
  design must not block it.
- On each machine a script can: **install or update** the client, **import the server config**, **set
  the permanent (fleet) password**, and **set client settings**. **Locking the settings UI** matters
  most. Every setting has its own toggle deciding whether the script manages it.
- Installer source: **GitHub releases with a pinned version by default, or an internal URL** that
  overrides it.
- **One fleet password**, stored **encrypted** in rdadmin so that a later feature ("Inject device
  passwords when Admins connect", Todoist) can build on it.
- Delivery: **generate and download** (approach A). Rejected: a hosted bootstrap URL with a deployment
  token, because it would serve the fleet password from the internet-facing listener behind only a
  token.

## Assumptions (stated to the user, not contradicted)

- One deployment profile for the whole installation. Per-group or per-site profiles are out of scope.
- Owners edit the profile and set the password; owners and admins may download scripts (admins need
  the password to connect anyway). Users (the role) have no access.
- A setting the stock 1.5.0 client cannot enforce is not offered. The catalog comes from research, not
  from memory.

## Out of scope

- macOS scripts (later; needs an MDM profile for screen-recording and accessibility permissions).
- Password injection when connecting (separate spec; starts with a research spike on what the stock
  client accepts).
- Hosted or self-updating scripts, per-device passwords, multiple profiles.

## Design

### 1. Data

New migration (next free number) with a single-row table, e.g. `deployment_profile`:

| Column | Meaning |
|---|---|
| `installer_source` | `github` or `url` |
| `client_version` | version to install or update to, e.g. `1.5.0` |
| `installer_url_windows`, `installer_url_linux_deb`, `installer_url_linux_rpm` | used when the source is `url` (HTTP(S); Windows also accepts a UNC path) |
| `sha256_*` | optional checksum per installer; when set, the script verifies it |
| `allow_downgrade` | boolean, default false |
| `settings` | JSONB: for each catalog key, `{include: bool, value: ...}` |
| `fleet_password_sealed` | nullable `bytea`: the password sealed with `SECRET_KEY` via `auth.Sealer.SealWithAAD` and a deployment-specific AAD |
| `password_set_at`, `password_set_by` | when and by whom it was last set |
| `updated_at`, `updated_by` | last profile change |

Rotating `SECRET_KEY` makes the sealed password unreadable, as it does TOTP and SSO secrets. The API
then reports the password as not set; the owner sets it again.

### 2. Backend: `internal/deploy`

- **Catalog**: a Go table of supported client settings (key, type, allowed values, default, OS
  support, label, help text), built from the research document (section 6, step 1). Profile values are
  validated against it.
- **Profile**: load and save (sqlc queries), seal and open the password.
- **Rendering**: Go `text/template` per OS (`windows.ps1`, `linux.sh`). Every value inserted into a
  script goes through an OS-specific quoting function (PowerShell single-quoted strings with `'`
  doubled; POSIX shell single quotes with `'\''`). No value is ever interpolated unquoted. The server
  config string is generated at render time with `connect.ConfigString` from the current server
  profile.

### 3. API (contract first; `internal/adminapi/openapi.yaml`)

- `GET /admin/api/v1/deployment/profile` (owner, admin): the profile, the catalog, and
  `password: {set: bool, set_at, set_by}`. Never the password.
- `PUT /admin/api/v1/deployment/profile` (owner): replaces the profile. `fleet_password` is
  write-only: absent keeps the current one, a string sets it (validation: the length rules the stock
  client accepts, from research), and an explicit `null` removes it. Audited in the same transaction as
  `deployment.profile_updated` (and `deployment.password_set` / `deployment.password_removed`), with
  no secret in the audit details.
- `POST /admin/api/v1/deployment/script` (owner, admin), body `{os: windows|linux}`: returns the
  script as an attachment (`text/plain`, `Content-Disposition: attachment; filename=rdadmin-deploy.ps1`
  or `.sh`). Audited as `deployment.script_downloaded` with the OS. POST, so the existing CSRF header
  and `Origin` checks apply. If the password is not set, the script is rendered without the password
  step; the API adds nothing for this, and the page warns before the download ("No fleet password is
  set; the script will not set one").
- Users get 403 `forbidden` on all three. Error format as usual.

### 4. The scripts

Same steps on every OS, each idempotent, each logging one line; the password never appears in any log
or output.

1. **Preflight**: Windows must run elevated (SYSTEM or administrator), Linux as root; otherwise exit
   with the "not elevated" code and change nothing.
2. **Install or update** (if included): compare the installed version with `client_version`; equal
   skips to step 3. Otherwise download (GitHub release asset for that version, or the profile URL),
   verify SHA-256 when set, install silently (Windows: the official installer's silent switch; Linux:
   `.deb` or `.rpm` by detected package manager). No downgrade unless `allow_downgrade`.
3. **Server**: import the server config string (as today's one-liner).
4. **Password** (if set): set the permanent password with the client's own switch.
5. **Settings**: apply each included setting with the client's option switches; the settings lock
   last. Settings not included are left untouched on the machine.
6. **Finish**: restart the RustDesk service if a step requires it; print the device ID; exit.

Exit codes: `0` success; distinct non-zero codes for not elevated, download or checksum failure,
install failure, and configuration failure. Logs: `%ProgramData%\rdadmin\deploy.log` (Windows),
`/var/log/rdadmin-deploy.log` (Linux).

### 5. Web UI: Settings → Deployment

Visible to owners and admins; admins see it read-only except for the download buttons.

- **Installer**: source (GitHub or URL), version, URLs, optional SHA-256 values, allow downgrade.
- **Fleet password**: "Set on <date> by <name>" or "Not set"; owners: Change password (entered twice,
  never shown again) and Remove.
- **Client settings**: one row per catalog entry with an "Include in script" toggle and the value
  control (switch or select); a note when a setting applies to one OS only.
- **Download**: Windows (.ps1), Linux (.sh), macOS shown as "coming later"; a warning that the file
  contains the fleet password and must be stored as a secret.
- Saving follows the existing settings-page pattern.

### 6. Order of work

1. **Research** (one task): from the RustDesk 1.5.0 client source, document in the repo
   (`testdata/contracts/`): silent-install switches (Windows exe/MSI, Linux packages), `--config`,
   `--password` and option switches and whether they work without a GUI session (as SYSTEM/root),
   the exact option names and values, whether and how the stock client can lock its settings UI
   (e.g. a PIN), password rules, and how to read the installed version. The user reviews the
   resulting catalog before step 2.
2. **Contract**: the three endpoints and schemas in `openapi.yaml`.
3. **Backend**: migration, `internal/deploy`, handlers, audit, tests. Ships with step 2 as one PR
   (the contract guard tests require it).
4. **Web**: the Deployment page.
5. **Lab gate** on the user's machines, then release **1.3.0**.

## Security

- The password is sealed at rest, never returned by any endpoint, never logged, never in audit
  details or error messages, and only ever written into a downloaded script.
- Every profile change and every download is audited in the same transaction, with actor and OS.
- Script rendering quotes every inserted value; hostile values (`'`, `"`, `$()`, backticks, `%`,
  newlines) are covered by tests.
- The security audit of the backend task covers the new endpoints, sealing and rendering.

## Testing

- **Go**: rendered scripts compared with golden files per OS for a fixed profile; escaping tests with
  hostile values; every rendered `.ps1` parses with PowerShell's parser and every `.sh` passes
  `bash -n`; API tests for roles (owner/admin/user), audit entries, and that the password never
  appears in any response body.
- **Web**: unit tests and e2e on the mock build: toggles, password set/change/remove, downloads, and
  the role differences.
- **Lab gate** (before 1.3.0): the user runs the Windows script on a real Windows machine (ideally via
  their RMM or GPO) and the Linux script on a real Linux machine against their work server. Pass: the
  client installs or updates, registers with rdadmin, accepts the fleet password, and shows the chosen
  settings, including the lock.

## Open questions for the research task

- Does the stock 1.5.0 client offer a settings lock, and can a script set it?
- Do `--password` and option switches work as SYSTEM/root with no logged-in user?
- Which options are stored where (and survive client updates)?
- Does GitHub publish checksums for client releases? If not, the SHA-256 fields stay optional and
  user-supplied.
