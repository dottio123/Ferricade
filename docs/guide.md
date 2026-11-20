# Ferricade deployment and administration guide

This guide covers deployment, setup, client configuration, and administration.
For an overview, see the [README](../README.md). Release changes are in the
[changelog](../CHANGELOG.md).

## Ports and services

| Port | Protocol | Service | Used by |
|---|---|---|---|
| 21114 | TCP, plain HTTP | Ferricade client API (`/api/heartbeat`, `/api/sysinfo`, `/healthz`) | RustDesk clients |
| 21120 | TCP, HTTP | Ferricade admin API (`/admin/api/v1/…`), setup (`/setup/…`), and client API | Admin console and HTTPS reverse proxy |
| 21115 | TCP | `hbbs` NAT test and online query | RustDesk clients and Ferricade |
| 21116 | TCP and UDP | `hbbs` ID and rendezvous server | RustDesk clients |
| 21117 | TCP | `hbbr` relay | RustDesk clients |

`deploy/compose.yml` runs Ferricade and PostgreSQL 16. Add
`deploy/compose.rustdesk.yml` when the same Compose project should run `hbbs`
and `hbbr`; omit it when a RustDesk server already exists. The included
RustDesk server stores its key in the persistent `rustdesk-data` volume.

RustDesk clients need the client API and RustDesk server ports. Admin access
uses the HTTPS URL configured as `PUBLIC_URL`. Port 21120 is an internal HTTP
listener and does not need to be exposed publicly. Keep port 21114 on HTTP
because clients derive that address themselves.

## Quick start

Download `deploy/compose.yml` and `deploy/.env.example` from the same release
into a `deploy/` directory, or clone this repository. Copy the example file:

```sh
cp deploy/.env.example deploy/.env
```

Set `FERRICADE_VERSION` to the release version, generate `SECRET_KEY` with
`openssl rand -base64 32`, generate `POSTGRES_PASSWORD` with
`openssl rand -base64 24`, and set `PUBLIC_URL` to the HTTPS console URL. Start
Ferricade and read the one-time setup token from its log:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml up -d
docker compose --env-file deploy/.env -f deploy/compose.yml logs app | grep 'setup token'
```

Open `<PUBLIC_URL>/first-run` and enter the token. The setup wizard creates
the owner, enrolls TOTP, checks the RustDesk server, and shows the client
configuration. A token is valid for 24 hours; restarting the service issues a
new token. The `/setup` routes return 404 after setup completes.

Keep the same `SECRET_KEY` and `POSTGRES_PASSWORD` for the lifetime of the
installation. `SECRET_KEY` encrypts stored TOTP and single sign-on secrets.
Changing `POSTGRES_PASSWORD` in the environment does not change the password
in an existing database volume.

To run the RustDesk servers in the same Compose project, set `RELAY_HOST` to
the address clients use for `hbbr` and set `HBBS_ADDR=hbbs:21115`. Include the
RustDesk Compose file when starting the stack:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml -f deploy/compose.rustdesk.yml up -d
```

The included servers use key authentication. The public key is created in the
`rustdesk-data` volume. Enter the content of `id_ed25519.pub` during setup and
configure the same key on RustDesk clients. To use existing `hbbs` and `hbbr`,
set `HBBS_ADDR` to the `hbbs` host and port 21115, or leave it empty to turn
off online queries.

## HTTPS and proxy settings

Set `PUBLIC_URL` to the HTTPS URL for the console and place an HTTPS reverse
proxy in front of the admin listener on port 21120. State-changing admin and
setup requests require an `Origin` that matches `PUBLIC_URL`. The session
cookie is also scoped to that origin. A second plain HTTP address cannot be
used for sign-in or changes.

By default, the host-side admin port binds to loopback. Set `ADMIN_BIND` to a
host address the reverse proxy can reach and `FERRICADE_ADMIN_PORT` to its
host port when needed. Set `TRUSTED_PROXIES` to the proxy's single source
address as Ferricade sees it, in CIDR notation. Only trusted proxy addresses
may supply the client address used in audit records and rate limits. Avoid
trusting a whole network range.

When the reverse proxy runs on another machine, the admin listener must bind
to an address that machine can reach. Port 21120 uses plain HTTP, so restrict
it to the proxy. Keep the public admin URL on HTTPS.

Docker Desktop may report the Compose network gateway instead of client
addresses. Audit entries can then show the gateway for client requests, and
RustDesk may use relay connections when direct connections cannot be
established. Check the addresses shown in audit records before choosing a
trusted proxy address.

The single sign-on redirect URL is `PUBLIC_URL` followed by
`/admin/api/v1/auth/oidc/callback`. Update the provider configuration if
`PUBLIC_URL` changes.

## Development and LAN testing

Use `deploy/compose.dev.yml` to build from source or test without TLS. It uses
a separate development stack and its own data. Copy `deploy/.env.example` to
`deploy/.env`, set a generated `SECRET_KEY`, then set `PUBLIC_URL` to an HTTP
test origin, `DEV_INSECURE=1`, and `ADMIN_BIND` to a test-interface address only on a trusted test
network. When including the RustDesk servers, set `RELAY_HOST` to the address
clients use and `HBBS_ADDR=hbbs:21115`.

```sh
docker compose --env-file deploy/.env -f deploy/compose.dev.yml --profile rustdesk up -d --build
```

Omit `--profile rustdesk` when using an existing RustDesk server. In insecure
development mode, session cookies are not marked Secure and HSTS is disabled.
Do not use this mode on an untrusted network.

### Windows PowerShell

`scripts/setup.ps1` and `scripts/approve-device.ps1` run the setup and approval
requests from PowerShell 7. They read passwords and TOTP codes from the
terminal without printing them. For a development instance, use the test
origin configured in `PUBLIC_URL`:

```powershell
pwsh -File scripts/setup.ps1 -AdminUrl https://admin.example.com -IdHost rustdesk.example.com
pwsh -File scripts/approve-device.ps1 -AdminUrl https://admin.example.com
```

Changing `POSTGRES_PASSWORD` after the database volume is first created does
not change its stored password.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | Set by Compose | PostgreSQL connection URL. |
| `SECRET_KEY` | Yes | None | Base64 encoding of at least 32 random bytes. Encrypts stored TOTP and single sign-on secrets. |
| `PUBLIC_URL` | Yes | None | External console URL. HTTPS unless `DEV_INSECURE=1`; HTTPS on port 21114 is not allowed. |
| `DEV_INSECURE` | No | Unset | Allows HTTP `PUBLIC_URL` for development and trusted LAN tests. |
| `HBBS_ADDR` | No | Disabled | `host[:port]` for `hbbs`, usually port 21115. Online queries run every 60 seconds for approved devices without a recent heartbeat. Do not use a loopback address. With `compose.rustdesk.yml`, use `hbbs:21115`. |
| `TRUSTED_PROXIES` | No | Empty | Comma-separated CIDRs allowed to provide `X-Forwarded-For`. Use the proxy's single source address. |
| `MAX_PENDING_DEVICES` | No | `500` | Stops recording unknown devices when this many are pending. |
| `CLIENT_LISTEN_ADDR` | No | `:21114` | Client API listener address. |
| `ADMIN_LISTEN_ADDR` | No | `:21120` | Admin listener address. |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error`, case-insensitive. |
| `LOG_FORMAT` | No | `text` | `text` or `json`, case-insensitive. |
| `FERRICADE_VERSION` | Compose | Required | Release tag of the published image. |
| `POSTGRES_PASSWORD` | Compose | Required | Password for the database volume. |
| `ADMIN_BIND` | Compose | Loopback | Host address for the admin port. |
| `FERRICADE_ADMIN_PORT` | Compose | `21120` | Host-side admin port. |
| `FERRICADE_CLIENT_PORT` | Compose | `21114` | Host-side client API port. Keep 21114 for RustDesk clients. |
| `RELAY_HOST` | With included servers | Required | Address clients use to reach `hbbr`. |

Ferricade writes application logs to stderr. Follow the Compose application
log with:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml logs -f app
```

## Roles and sign-in duration

Owners can manage all settings, users, and devices. Admins can manage the fleet
but cannot manage users, sign-in settings, server settings, or fleet
thresholds. Users can view and connect only to devices assigned directly or
through groups and subgroups. Users cannot change fleet settings and see only
their own activity. Single sign-on can map provider groups to roles.

An owner can choose sign-in duration in System Settings → Sign-in: until the
browser closes, 8 hours, 1 day, 7 days, or 30 days. Timed sessions survive
browser restarts after the second factor is complete. Shortening the duration
also shortens open sessions and may sign users out.

## First-run setup API

The web wizard is the simplest setup path. Scripts can call the setup API.
First start logs a one-time token and `setup_api_base`. Send the token in
`X-Setup-Token`. State-changing requests also need an `Origin` header equal to
`PUBLIC_URL`. Browsers send that header automatically. The token is valid for
24 hours; a restart issues a new one. Setup routes are removed when setup is
complete.

The following example uses `curl` and `jq`. Replace the token and current TOTP
code with values from the installation. The owner password must be at least
12 characters and cannot be a common password or the username.

```sh
ADMIN=https://admin.example.com       # Set this to PUBLIC_URL.
TOKEN='<setup token from the application log>'
setup() { curl -sS -H "Origin: $ADMIN" -H "X-Setup-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; echo; }

# Create the owner account.
setup -d '{"username":"owner","password":"a long passphrase here","display_name":"Owner"}' "$ADMIN/setup/owner"

# Generate the owner's TOTP secret; then enroll it in an authenticator.
setup -X POST "$ADMIN/setup/owner/totp" | jq

# Verify the current code from the authenticator.
setup -d '{"code":"<current-code>"}' "$ADMIN/setup/owner/totp/verify"

# Save and check the RustDesk server profile.
setup -d '{"name":"main","id_host":"rustdesk.example.com","relay_host":"rustdesk.example.com","public_key":"<id_ed25519.pub>"}' "$ADMIN/setup/server"

# Complete setup and return client_config.
setup -X POST "$ADMIN/setup/complete" | jq
```

The server profile is saved even when a reachability check fails. The checks
cover the ID server, relay, client API, and the configured online query. For
request and response schemas, see the [API contract](../internal/adminapi/openapi.yaml).

## Configure RustDesk clients

The `client_config` returned by setup and by
`GET /admin/api/v1/server/client-config` contains:

- `host`: The RustDesk ID server address.
- `relay`: The relay server address.
- `api`: The client API address. When no API URL is set, it defaults to `http://<ID host>:21114`.
- `key`: The content of `id_ed25519.pub`.
- `config_string`: An import value containing `host`, `relay`, `api`, and `key`.
- `deep_link`: A `rustdesk://config/<config_string>` link for mobile clients that support config links. The RustDesk 1.5.0 desktop client ignores it.
- `install.windows`, `install.macos`, and `install.linux`: Commands that apply the four settings to an installed client. They require administrator or root rights.

Import `config_string` in RustDesk under Settings → Network → ID/Relay
server → Import server config, or run the install command for that operating
system. To configure a client by hand, set the ID server, relay server, and
public key. Leave the API server empty when the client API is reachable at
`http://<ID host>:21114`; otherwise set it to that client API address or to
the HTTPS `PUBLIC_URL`.

The deploy scripts pass the RustDesk password and settings unlock PIN as
command-line arguments because RustDesk 1.5.0 offers no other input method.
While a script runs, other local users and endpoint tools can read those values
from the process list. Run deployments unattended on machines you control, and
change the password afterwards if that exposure matters.

After configuration, a device usually reports in within 15 to 30 seconds and
appears as pending. Clients that report before setup is complete are ignored.

## Approve devices and connect

Review pending devices in the console and approve them there. The API flow
below shows the corresponding calls. The session cookie, `Origin`, and CSRF
token are required for state-changing requests. The TOTP code used during
setup cannot be used again; wait for the next code.

```sh
ADMIN=https://admin.example.com
JAR=$(mktemp)
CSRF=
api() { curl -sS -b "$JAR" -c "$JAR" -H "Origin: $ADMIN" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' "$@"; }

CSRF=$(api -d '{"username":"owner","password":"a long passphrase here"}' "$ADMIN/admin/api/v1/auth/login" | jq -r .csrf_token)
CSRF=$(api -d '{"code":"<current-code>"}' "$ADMIN/admin/api/v1/auth/totp" | jq -r .csrf_token)
api "$ADMIN/admin/api/v1/devices?state=pending" | jq '.items[] | {id, rustdesk_id, hostname, os, online}'
api -X POST "$ADMIN/admin/api/v1/devices/<device-id>/approve" | jq '{state, online}'
api "$ADMIN/admin/api/v1/devices/<device-id>/connect" | jq
```

A connect response includes a `rustdesk://` URL and a command. For example:

```json
{
  "url": "rustdesk://123456789@rustdesk.example.com?key=<encoded-key>",
  "command": "rustdesk --connect \"123456789@rustdesk.example.com?key=<encoded-key>\"",
  "id": "123456789",
  "includes_server": true
}
```

The connect link can include the ID server and key, so it can be used by a
client that has not already been configured for this server. An owner can
change that setting so links work only for configured clients. The connect
endpoint also accepts `action=file-transfer`, `action=port-forward`, or
`action=terminal`, and `relay=1` to request relay use. The audit endpoint lists
recent administrative actions:

```sh
api "$ADMIN/admin/api/v1/audit" | jq '.items[] | {at, action, target_id}'
```

## Client policies and access windows

Assign named policies to groups. Child groups inherit their parent's policy;
devices without an assigned policy use Default. Policy push is off until an
owner enables it. When on, Ferricade sends catalog settings through the client
heartbeat and stock clients apply them within about 15 seconds. Passwords and
the settings unlock PIN are never pushed. Devices keep the settings they last
received when policy push is turned off.

Owners and admins can open access windows for 1, 4, or 8 hours, or until
manually closed. A policy can request disconnect when a window closes. The
close remains unconfirmed until the device reports the baseline settings. An
alert is raised if confirmation has not arrived after five minutes.

Policy push cannot be switched off, and a device cannot be archived, reopened,
or deleted while it has an open access window. The ID allow lists are also
sent through client policies while policy push is on. Global, group, and
device lists add to each other. They limit which self-reported RustDesk IDs a
client accepts; they are not authentication. Blocked attempts are audited, and
repeated attempts within ten minutes are summarized.

## Live updates and sessions

`GET /admin/api/v1/events` is a server-sent event stream. It uses the signed-in
session and MFA state and allows at most five streams per session. Messages
carry event types and IDs; the console fetches current details through the API.
The event types are:

- `device.updated`, `device.enrolled`, `device.deleted`, `device.online`, and `device.offline`.
- `session.started`, `session.updated`, and `session.ended`.
- `audit.created` and `preferences.updated`.
- `group_rules.updated` and `id_allow_list.updated`.
- `resync`, which ends the stream so the client reconnects and fetches current data.

Remote sessions use connection audits sent by RustDesk clients and heartbeat
connection data. The Sessions page lists them; `/sessions`, `/sessions/stats`,
`/stats/summary`, and `/stats/history` provide the underlying API views. To
simulate clients and sessions against a running client listener:

```sh
go run ./cmd/rdsim -devices 3 -sessions 20s -session-length 10s
```

## Log export

Owners configure **Settings → Log Export**. Admins can view settings and
status. Ferricade can export audit events and remote session start and end
events to a local JSON Lines file, a syslog collector, or both. Each output is
off by default. Enabling an output starts delivery from that time; earlier
events are not replayed.

### Log file

The file output has one setting: whether it is enabled. The container path is
`/var/log/ferricade/events.jsonl`, mounted from `./logs` beside the Compose
file. Files rotate at 10 MB, up to ten old files, and use mode `0640`. The
container runs as UID 65532, so the mounted directory must be writable by
that user or its group. The settings page shows output status and supports a
test event. If the directory is unavailable, queued events wait for up to
seven days.

### Syslog

The syslog output has these settings:

- `enabled`: Turn delivery on or off.
- `host`: Collector host name; required when enabled.
- `port`: Collector port from 1 to 65535. The usual ports are 6514 with TLS and 514 without TLS.
- `tls`: Use TLS 1.2 or newer and verify the collector's host name.
- `ca_pem`: Optional extra PEM certificates trusted in addition to system roots. When set, the value must contain at least one certificate.
- `facility`: One of `kern`, `user`, `mail`, `daemon`, `auth`, `syslog`, `lpr`, `news`, `uucp`, `cron`, `authpriv`, `ftp`, or `local0` through `local7`. The default is `local0`.
- `format`: `json` or `text`.

Syslog uses RFC 5424 over TCP with octet-counted framing. It does not use UDP
or RFC 3164. The message severity is warning for failures and notice
otherwise. The MSGID is the event action.

### Export formats and delivery

JSON format writes one JSON object per line with ECS-style fields and a
readable `message`. For example:

```json
{
  "@timestamp": "2026-11-18T14:03:12.481Z",
  "event": {"id": "<event-id>", "kind": "event", "category": "configuration", "action": "device.approved", "outcome": "success"},
  "message": "An operator approved Example device (123456789)",
  "user": {"id": "<user-id>", "name": "Operator", "roles": ["admin"]},
  "source": {"ip": "<client-address>"},
  "ferricade": {"target": {"type": "device", "id": "<device-id>", "name": "Example device"}, "device": {"rustdesk_id": "123456789"}, "details": {}},
  "observer": {"product": "Ferricade", "version": "2.1.1", "hostname": "admin.example.com"}
}
```

Text format writes `action=… outcome=… user=… source_ip=… target=…
device=… msg="<sentence>"`. Values are quoted where needed, and control
characters are escaped.

The page shows each output's pending count, last delivery time, and last
error. An owner can send a test event to either output using its saved settings,
even while that output is off. Test events are delivered directly, are not
queued, and are not audited. A settings change that disables an output or
changes its syslog destination is sent to the previous destination first.

Delivery is at least once. A duplicate can occur after a crash or dropped
syslog connection, so consumers should de-duplicate on `event.id`. Events wait
while an output is unavailable, up to seven days. Pending session events are
dropped if their device is deleted; the `device.deleted` event is exported.

## Automatic grouping

Owners and admins can add Auto-Sort Rules to groups. A pattern matches the
whole hostname reported by the RustDesk client and ignores case. `*` matches
any number of characters; `?` matches one character. Patterns may contain
letters, digits, `.`, `_`, `-`, `*`, and `?`, up to 128 characters. A group
can have up to 20 patterns. The Groups page previews matching pending and
approved devices while rules are edited. For example, `w-*-it-*` matches
`w-east-it-01`.

When a pending or rejected device without a group is approved, Ferricade
assigns it to the one matching group. A group selected during approval takes
precedence. Restoring an archived device does not sort it. Renaming a device
does not move it automatically.

If patterns in multiple groups match, the device stays ungrouped and gets a
Group conflict flag in its device panel and under Needs attention. During
approval, choose a group or leave the device ungrouped. Bulk approval flags
conflicts for later resolution. Moving a device another way clears the flag.

Auto Sort All previews the result before an owner confirms. One match moves
the device to that group, even if it was assigned by hand. No match leaves it
in place. Multiple matches flag a conflict without moving it. Moved devices
inherit the new group's client policy. Each move is recorded as
`device.updated` with reason `auto_sort`; the run also adds a
`devices.auto_sorted` summary. There is no undo. If devices are busy, the run
stops without changes.

The Devices page also lets owners and admins move selected devices to a group
or approve, reject, archive, restore, tag, or delete them.

## Recovery

The `ferricade` binary includes three account recovery commands for cases when
no owner can sign in. Run them in the application container. They need only
`DATABASE_URL`, use a transaction, print one line, and write an audit event.

```sh
# Clear failed sign-ins and the account lock.
docker compose --env-file deploy/.env -f deploy/compose.yml exec app ferricade user unlock owner

# Remove the TOTP secret and end sessions. The next sign-in enrolls a new secret when required.
docker compose --env-file deploy/.env -f deploy/compose.yml exec app ferricade user reset-totp owner

# Set a password for an SSO-only owner. The command prompts for it twice and ends open sessions.
docker compose --env-file deploy/.env -f deploy/compose.yml exec app ferricade user set-password owner
```

The audit actions are `user.unlocked_cli`, `user.totp_reset_cli`, and
`user.password_set_cli`. If TOTP is required, the next sign-in after a reset
enrolls a new authenticator. Wrong TOTP codes, unknown usernames, and
per-client-address rate-limit counters are held in memory. Locks expire on
their own after at most an hour; restarting the application clears the
counters.

## Web console and development

The admin listener serves the web console at the same origin as the admin API.
The Docker image builds the web app and embeds it in the application binary.
The web UI can also be built outside Docker with Node.js 24:

```sh
make web          # Build web/dist.
make build        # Build the binary after web/dist exists.
make web-dev      # Start the development server with a mock API.
```

To develop against a running Ferricade instance, run `npm run dev:live` from
`web/` with `FERRICADE_URL` set to that instance's `PUBLIC_URL`. The app checks
each state-changing request's origin against `PUBLIC_URL`.

Development commands use Go and PostgreSQL 16. Database tests skip when
`TEST_DATABASE_URL` is unset. Regenerate database code after SQL query or
migration changes with `make sqlc`:

```sh
make test-db
TEST_DATABASE_URL='postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable' REQUIRE_DB=1 make test
make vet
```
