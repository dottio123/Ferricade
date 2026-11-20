# Changelog

All notable changes to Ferricade are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Ferricade uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-11-20

### Added

- Opt-in plain HTTP for LAN-only installs with a console warning.
- Quiet plain-HTTP indicator in the console header and sign-in page when served over HTTP.

### Changed

- Server settings and first-run setup now warn when clients cannot reach a local or container-only host.
- Origin failures identify the configured console address on the sign-in page.
- The production Compose file includes hbbs and hbbr behind the `rustdesk` profile; older two-file setups still work.

## [2.1.1] - 2026-11-20

### Changed

- The README now uses the Ferricade wordmark and refreshed screenshots.

### Fixed

- The unpinned sidebar slides open and closed, shows About, System Settings and the profile when expanded, and closes when the pointer leaves, including after unpinning or selecting a page.

## [2.1.0] - 2026-11-20

### Added

- Ferricade logos, app icons, a sign-in introduction, and a full-page loader.
- Sidebar pinning with automatic collapse.

### Changed

- Brand marks adapt to the active theme, and Ferricade is the default palette.
- About shows recent releases, while tag labels use readable text colours.

### Fixed

- Clearing a device alias or note now saves the empty value.

## [2.0.0] - 2026-11-18

### Breaking (2.0.0)

- Settings use the `FERRICADE_*` prefix; `RDADMIN_*` values are no longer read.
- The container image is now `ghcr.io/dottio123/ferricade`.
- Session and OIDC cookie names changed, signing everyone in again.
- Log-export record keys use Ferricade names.
- New installs default to the `ferricade` Postgres role and database and the `ferricade_pgdata` volume.

### Added

- Allowed IDs show the matching device and its user on hover; clicking one opens that device, and a device opened from another device's panel has a link back to it.

### Changed

- The application, commands, deployment files and user interface are now named Ferricade.
- The README and deployment guide now describe the public Ferricade project and its current setup.

### Fixed

- Deployment settings reject malformed latest-release URLs before generating install scripts.
- Session history associates authenticated remote sessions with the correct user, and pending devices no longer contribute sessions.
- Login lockouts appear as failures in exported audit logs.

### Security

- Replacing a TOTP authenticator now requires reauthentication; sign-in rate-limit state is bounded and locked unknown accounts skip password hashing.
- Live event streams are capped per user, and heartbeat and system-information fields are bounded.
- Forwarded client addresses are parsed from the correct proxy hop, and unauthenticated OIDC callbacks no longer create audit entries.
- Install scripts require checksums for downloads from insecure URLs and use protected temporary files.

## [1.9.13] - 2026-11-15

### Added

- Container logs are readable text by default; set LOG_FORMAT=json for log shippers and LOG_LEVEL (debug, info, warn, error) for detail.
- Startup summary in the log: version, listeners, database and migrations, setup state, and warnings when setup is incomplete or the server key is missing.
- A log line per request on the admin and RustDesk client listeners, with a request ID that matches the X-Request-ID response header.
- Log lines for device enrollment, approval, rejection, deletion, online and offline, for sign-ins, lockouts and rejected requests, and a status line every 15 minutes.

### Fixed

- The image reports its release version at startup and in exported log records instead of dev.

## [1.9.12] - 2026-11-14

### Changed

- Users page: actions other than Edit and Assign devices are in a More actions menu; users show as cards on phones and the table fits tablets.
- User dialogs scroll on small screens and the password rules wrap cleanly.
- Assign devices: devices show their alias and group, and the Groups and Devices headings count what is selected.

### Fixed

- An owner changing their own role is asked to confirm first.

## [1.9.11] - 2026-11-13

### Changed

- Sign-in settings: the sign-in duration is a dropdown; a duration set some other way is shown as it is.
- Audit log: the action filter lists every action and can be searched.
- Settings: the effective ID allow list is grouped under the source it comes from.

### Fixed

- Device panel: the connect link box names the link once and keeps its height while the link reloads.

## [1.9.10] - 2026-11-13

### Added

- Audit log: failed sign-in lockouts that a device's RustDesk reports are recorded.

### Changed

- Device panel: the RustDesk connect link is a collapsible box; opening it shows the link without launching RustDesk.
- Deployment scripts check the server key and relay server after configuring RustDesk and set them again if they differ. A script cannot be downloaded while the server's public key is empty.

### Fixed

- Connect links keep "=" and "/" in the server key.

## [1.9.9] - 2026-11-13

### Added

- A confirmation message after every save or create: groups, tags, users, policies, policy push and the ID allow lists.

### Changed

- Deployment: the Secrets and security card now sits above the Save button.
- Settings: the global ID allow list is now called the Global ID Allowlist.

## [1.9.8] - 2026-11-13

### Added

- Deployment: an option to set the ID allow list of each newly installed device to the global list (off by default). The list is copied into the script when it is downloaded; new devices refuse every unlisted ID until they are approved with policy push on.
- Policies: a notice showing the global ID allow list's size, with a link to edit it.

## [1.9.7] - 2026-11-13

### Added

- ID allow lists: global, per-group and per-device lists of RustDesk IDs allowed to connect, pushed to devices with client policies. IDs are self-reported, so this limits exposure; it is not authentication. Blocked attempts are written to the audit log; repeats within 10 minutes are summarised in one entry.

## [1.9.6] - 2026-11-12

### Added

- Settings > Server: a switch to leave the ID server and key out of connect links, so only clients already set up for this server can use them; on by default.
- Settings > Server: an optional client API address, so clients can send heartbeats and receive policies over https through a TLS proxy; blank keeps http://<ID server>:21114.

### Changed

- hbbr in `deploy/compose.rustdesk.yml` now requires the server key (`-k _`; hbbs already did, the flag is now explicit on both): clients without the right key can no longer use the relay. Check every client has the key before upgrading.

## [1.9.5] - 2026-11-12

### Added

- Devices: the list shows each device's primary user (the OS user the client reports) under the device name; an empty value shows a dash.

### Fixed

- Dashboard: on the Activity Trend 7d and 30d ranges, hovering the chart now shows the sessions of the hovered point, with its date and hour, instead of the first point of that day (often 0).

## [1.9.4] - 2026-11-05

### Changed

- Dashboard: Platform mix lists Linux machines by distribution (Ubuntu, Debian, Fedora, ...) instead of Other, sorted by device count; Other now means the operating system could not be read. When there are more rows than fit, the last one shows how many more.

### Fixed

- Dashboard: Fleet pulse no longer squeezes or cuts off its tiles on portrait tablets; it shows a 2x2 grid there.
- Dashboard: Fleet overview scrolls inside the widget when many groups are expanded.
- Devices: turning on Include subgroups no longer shifts the Group filter.
- Development dependencies updated to clear npm audit findings (no change to the shipped app).

## [1.9.3] - 2026-10-24

### Changed

- Internal clean-up with no change in behaviour: about 1,000 fewer lines in the web UI and server, one fewer web dependency (`motion`; the device list's animations now use CSS), and the device panel, approval queue and date filters share their building blocks with the rest of the app.

### Removed

- The old addresses `/settings/account`, `/settings/appearance`, `/settings/dashboard`, `/settings/policies` and `/users` no longer redirect; bookmarks to them show the not-found page.

## [1.9.2] - 2026-10-24

### Security

- Two-factor lockouts are stored in the database, so an owner's reset or `rdadmin user unlock` clears them at once; an unknown username answers like a real one even under a flood of sign-in attempts; failed sign-ins expire after an hour without failures; `rdadmin user set-password` also unlocks the account.
- Disabling a user, resetting a password or two-factor, or newly requiring two-factor ends that user's live-update streams at once.
- OIDC profile pictures are fetched only from public internet addresses.

### Fixed

- A burst of new devices can no longer exceed the approval queue limit.
- On phones the Sessions and Audit Log time-range buttons fit without scrolling; the Include attempts switch no longer moves when Reset appears; a peer's RustDesk ID stays on one line in the Sessions list; the Groups page's Ungrouped devices card opens the device list filtered to ungrouped devices.

### Changed

- Faster Audit Log filtering by device or user and faster cleanup of stale sessions (new indexes, migration 00019); migration 00020 adds the sign-in lockout columns. Both run automatically on start.

## [1.9.1] - 2026-10-24

### Fixed

- The Audit Log shows a readable sentence for every action, including sign-in duration changes, group pattern changes, Auto Sort runs, access grant changes and deployment settings.
- The Sessions and Audit Log pages fit phone screens: sessions show as cards with their full status, and the filters line up.

## [1.9.0] - 2026-10-24

### Added

- Account → Appearance lets you keep notifications open until closed or close them after 3, 5, 10, or 30 seconds.
- Owners can set sign-in duration in System Settings → Sign-in: until the browser closes (the default), 8 hours, 1 day, 7 days, or 30 days. A sign-in becomes persistent only after two-factor authentication completes.
- The Devices page can show ungrouped devices, include subgroups in the group filter, and sort by Status, Device, State, OS, or Group. A Sort menu is available on phones.
- Fleet overview shows top-level groups with subgroup roll-ups, devices ordered by urgency, status bars for large groups, and expandable subgroups.

### Fixed

- Notifications now close on their own after the selected duration.
- Group conflicts can be resolved by choosing the current group; removing a rule or deleting a group also updates open conflicts.
- Groups, Tags, and command palette results work better on phones.

### API

- Added `GET /stats/fleet-map` and `GET`/`PUT /settings/sessions`.
- Device lists accept `ungrouped`, `subgroups`, `sort`, and `order`; `Preferences` includes `toast_seconds`.
- A device PATCH that sets `group_id` resolves an open group conflict.

### Upgrade notes

- Migration 00018 runs automatically. Sign-in duration stays "until the browser closes" until an owner changes it.

## [1.8.1] - 2026-10-23

### Changed

- Group counts on the Groups page include devices in subgroups, with the group's own count shown beside them.

## [1.8.0] - 2026-10-22

### Added

- Automatic grouping by device-name pattern at approval, with a group conflict flag and resolution window. Owners can run Auto Sort All; group conflicts also appear in Needs attention.
- Move to Group and Delete actions for selected devices.

### Upgrade notes

- No migration steps are needed; migration 00017 runs automatically. Grouping rules start empty, so device placement does not change until you add a pattern.

## [1.7.0] - 2026-10-22

### Added

- Log export: every audit event and every remote session start and end can be written to a rotating JSON Lines file and sent to a syslog server (RFC 5424 over TCP, optionally TLS), in ECS-style fields with a readable message. Both outputs are off until the owner turns them on in Settings → Log Export; see "Log export" in the README for setup, including Zabbix.
- The compose file mounts `./logs` into the container at `/var/log/rdadmin` for the log file.

### Upgrade notes

- If you plan to turn the file output on, create `./logs` with the right owner before upgrading (README, "Log export"). Docker would otherwise create it owned by root, and the container could not write to it.

## [1.6.0] - 2026-10-21

### Added

- Client policies: named policies, assigned to groups and inherited down the group tree, push client settings to approved RustDesk clients through the heartbeat, so devices stay configured without re-running a script. Only settings from the Deployment catalog are pushed, never passwords or the unlock PIN. Policy push is off until the owner turns it on. Policies has its own place in the main navigation.
- Policies and deployment scripts can manage more client settings: the permission preset, remote printer, camera, terminal, blocking user input, privacy mode, remote configuration changes, keeping the screen awake, connecting only while the RustDesk window is open, and disconnecting after inactivity.
- Access windows: an owner or admin can let a device accept password logins for 1, 4 or 8 hours or until switched off, optionally disconnecting its sessions when the window closes. The device panel warns until the device confirms the close, and an alert is raised after 5 minutes.
- Connect follows the access policy: when a device's policy refuses password logins and nobody at the device can accept, Connect is disabled until an access window is open, for every role.

### Changed

- When a policy or a deployment script manages individual permissions, it also sets the device's permission preset to Custom, so "Full access" on the device no longer overrides them.
- Navigation labels and page titles use Title Case.

### Fixed

- The buttons in some confirmation dialogs touched each other.

## [1.5.3] - 2026-10-20

### Changed

- The browser tab icon and the title bar of the installed app follow the chosen color palette and light or dark theme. The installed app's own icon stays the one it was installed with.

## [1.5.2] - 2026-10-20

### Added

- Deployment scripts can install the latest RustDesk release: choose "Latest release" as the client version on the Deployment page, and each script asks GitHub for the newest release when it runs. A device that already has RustDesk keeps its version and is still configured when GitHub cannot be reached.

### Changed

- "Latest release" is the default client version for installations that never saved a deployment profile. Saved profiles keep their version. Checksums can only be set for a specific version.

## [1.5.1] - 2026-10-20

### Changed

- The Deployment page's download card lists what each script does on a device, and the download buttons are disabled while the page has unsaved changes.

### Fixed

- After changes in the console, closing a device panel and opening another device could leave the panel behind its dark overlay, so none of its buttons could be clicked.
- The Deployment page's download warnings describe the saved settings, which the script is built from. Before, unsaved changes could make them describe a different script.

## [1.5.0] - 2026-10-16

### Added

- The rdadmin image is published for `linux/arm64` as well as `linux/amd64`, so it runs on 64-bit ARM servers such as a Raspberry Pi 4 or 5 with a 64-bit OS, or ARM cloud instances. Docker pulls the right one automatically.

## [1.4.3] - 2026-10-16

### Changed

- When the fleet password or the settings unlock PIN is included in the deployment script but not set, the script now removes it from the device, and the Deployment page warns about this before the download. Before, the device kept its old password or PIN.

### Fixed

- Deployment scripts check that the RustDesk client confirmed each password and PIN change, so a refused change is reported as a failure instead of a success.
- If a stored fleet password or unlock PIN can no longer be decrypted (for example after `SECRET_KEY` changed), downloading a script fails with a message to set it again instead of producing a script that would remove it from devices.

## [1.4.2] - 2026-10-16

### Changed

- The Deployment page describes every client setting in plain language and shows its options by name (for example "Password or click", "On", "Off") instead of raw values.

### Fixed

- The "Password or click" option for how incoming connections are accepted can be chosen again; before, the deployment settings rejected it.

## [1.4.1] - 2026-10-15

### Fixed

- Deployment scripts restart the RustDesk service after installing or updating the client and check that the new version is running, so an upgrade no longer leaves the old version running or the service stopped. They also read the installed version safely on Windows.
- Accounts created or used through single sign-on get the provider's email address (shown for information; only verified addresses are used to match accounts) and, with Microsoft Entra ID, the profile photo.
- The Account page names you by your display name.
- The Disconnect button is red and uses a "disconnect" symbol instead of a power symbol.

## [1.4.0] - 2026-10-15

### Added

- Deployment Assist (new, please report problems): Settings → Deployment prepares unattended scripts for Windows (PowerShell, run as Administrator or SYSTEM) and Linux (sh, run as root) that install or update the RustDesk client, point it at this server, set a fleet password and a settings unlock PIN, and apply chosen client settings. Owners edit the profile; owners and admins download the scripts. The password and PIN are stored encrypted and never shown again.
- Owners and admins can disconnect an open remote session from the device panel, the Sessions page and the Live sessions widget. The session ends within a few seconds and shows "Disconnected by an administrator".
- Server checks show where each check connected (host and address) and, when one fails, a plain-language hint (name not resolved, connection refused, timeout, unreachable).

### Fixed

- The "Sign in with …" button was missing on the sign-in page after a redirect when single sign-on is on.

## [1.3.0] - 2026-10-14

### Added

- Owners and admins can create a tag right from a device's "Add tag" menu ("Create tag…"); the new tag is added to the device when you save.

### Fixed

- The database container starts on Podman hosts where `no-new-privileges` made Postgres hang or fail at its first start. It now runs as the `postgres` user instead of starting as root.

## [1.2.0] - 2026-10-14

### Added

- The server checks also try the client API address RustDesk clients are given (port 21114 by default), so a missing port forward shows as a failed check (`client-api` in POST /server/check and GET /server/health).
- Stable releases are also published as `ghcr.io/dottio123/rdadmin:latest`; prereleases are not.
- The README explains running the HTTPS proxy on another machine and which ports must be reachable from the internet.

### Changed

- In kiosk mode the status badge also reports RustDesk server issues, like the Live indicator.
- "Add tag" in the device panel stays visible when every tag is applied, disabled, with a link to the Tags page.

### Fixed

- Users no longer see a "Pending 0" tile in Fleet pulse.

## [1.1.0] - 2026-10-14

### Added

- Click the Live indicator to see what is wrong with the rdadmin connection or the RustDesk server, and check again.
- rdadmin checks the RustDesk server every minute and logs when a check fails or recovers (GET /server/health).

### Changed

- The Live indicator pulses green while live, turns orange while reconnecting and grey when the server is offline.

### Fixed

- The sidebar and the top bar line up on tablets with larger text or display scaling.

## [1.0.1] - 2026-10-13

### Fixed

- The sidebar and the top bar line up on tablets.

## [1.0.0] - 2026-10-13

### Changed

- The top bar with search and the menu stays in view while a page scrolls.

### Fixed

- Live sessions rows no longer overlap in small dashboard cards or on phones.

## [1.0.0-rc.2] - 2026-10-13

### Added

- The console can be installed as an app on phones and desktops.

## [1.0.0-rc.1] - 2026-10-13

### Added

- Pushing a release tag publishes the Docker image to GitHub Container Registry.
- Production deployment files: a compose file for the published image, an add-on for hbbs/hbbr, and a documented `.env.example`.
- A User role: accounts that see and connect to only the devices or groups an owner assigns, with their own activity log and a dashboard limited to their devices.
- Owners assign devices and groups to Users from the Users page.
- SSO can map provider groups to the User role.
- Owners can reset another account's password from the Users page.

### Changed

- The database password must be set for production; the build-from-source setup moved to `deploy/compose.dev.yml`.
- Every password form lists all of the password rules.
- Group pickers show the group hierarchy, can be collapsed and searched.

### Fixed

- Accounts with optional two-factor sign in without being asked to set it up.
- The Appearance page's loading state is announced correctly to screen readers.

### Security

- Users can reach only an explicit list of API operations; every other operation, and any added later, is limited to owners and admins.

## [0.7.0] - 2026-10-12

### Added

- An About window, opened from the bottom of the sidebar, shows the version and this changelog.
- The README explains how to use the admin console from a local network and a phone.

### Changed

- The sidebar stays in view while a page scrolls, and tightens its spacing on short windows so every item fits.

### Fixed

- The “Re-enroll authenticator” button stays inside its card on phones.
- Device panel audit entries use a two-line list on phones instead of overlapping columns.

## [0.6.0] - 2026-10-12

### Added

- Sign in with one OpenID Connect provider, with just-in-time accounts, roles from provider groups, verified-email linking, and profile photos.
- Owners can configure the identity provider and manage linked single sign-on accounts.
- The `rdadmin user set-password` recovery command gives an account, such as an SSO-only owner, a password from the server's shell.
- Pages share a consistent visual style, including the reorganized system and user settings.
- Closing a dialog or side panel returns focus to its opener, and Escape closes only the topmost overlay.

### Security

- Single sign-on refuses ambiguous account matches and never demotes the last owner.
- Sign-in flow state is protected and unsafe return destinations are rejected.

## [0.5.0] - 2026-10-11

### Added

- Admins can undo device approvals and reopen approved devices.
- The console supports phone-width screens and text zoom up to 200%.
- Closing the last browser tab signs admins out within five minutes; sessions last no more than seven days.
- System settings, user settings, and account controls have separate navigation areas.

## [0.4.0] - 2026-10-11

### Added

- Choose among six colour themes, including Graphite, Ocean, Violet, Moss, and Sandstone.
- Each admin's colour theme is saved with their account and chosen on the new Appearance page.
- Visual previews make it easier to compare themes before choosing one.

## [0.3.0] - 2026-10-10

### Added

- The command center dashboard has clearer fleet summaries, trends, and rearrangeable modules.
- A wall display presents fleet status in a focused kiosk view.
- Dashboard layouts can be tailored with module sizes and saved preferences.

## [0.2.0] - 2026-10-09

### Added

- A web console provides sign-in, first-run setup, and navigation across admin pages.
- Review devices, approve them, manage groups and tags, and open RustDesk connect links.
- Manage users and review remote session history and statistics.
- Browse the append-only audit log in a searchable timeline.
- Live updates keep device, session, and audit information current in the console.

## [0.1.0] - 2026-10-06

### Added

- rdadmin serves stock RustDesk clients alongside unmodified `hbbs` and `hbbr` servers.
- Devices report in to an approval queue, show online status, and provide `rustdesk://` connect links after approval.
- First-run setup creates the owner account, configures TOTP, and saves the RustDesk server connection details.
- Accounts sign in with a password and TOTP (required for owners), and every admin action is recorded in an append-only audit log.
- Docker Compose runs rdadmin with Postgres and can optionally run `hbbs` and `hbbr`.

[2.0.0]: https://github.com/dottio123/ferricade/releases/tag/v2.0.0
[1.9.13]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.12...v1.9.13
[1.9.12]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.11...v1.9.12
[1.9.11]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.10...v1.9.11
[1.9.10]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.9...v1.9.10
[1.9.9]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.8...v1.9.9
[1.9.8]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.7...v1.9.8
[1.9.7]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.6...v1.9.7
[1.9.6]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.5...v1.9.6
[1.9.5]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.4...v1.9.5
[1.9.4]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.3...v1.9.4
[1.9.3]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.2...v1.9.3
[1.9.2]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.1...v1.9.2
[1.9.1]: https://github.com/dottio123/rustdesk-webui/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/dottio123/rustdesk-webui/compare/v1.8.1...v1.9.0
[1.8.1]: https://github.com/dottio123/rustdesk-webui/compare/v1.8.0...v1.8.1
[1.6.0]: https://github.com/dottio123/rustdesk-webui/compare/v1.5.3...v1.6.0
[1.5.3]: https://github.com/dottio123/rustdesk-webui/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/dottio123/rustdesk-webui/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/dottio123/rustdesk-webui/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/dottio123/rustdesk-webui/compare/v1.4.3...v1.5.0
[1.4.3]: https://github.com/dottio123/rustdesk-webui/compare/v1.4.2...v1.4.3
[1.4.2]: https://github.com/dottio123/rustdesk-webui/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/dottio123/rustdesk-webui/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/dottio123/rustdesk-webui/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/dottio123/rustdesk-webui/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/dottio123/rustdesk-webui/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/dottio123/rustdesk-webui/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/dottio123/rustdesk-webui/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/dottio123/rustdesk-webui/compare/v1.0.0-rc.2...v1.0.0
[1.0.0-rc.2]: https://github.com/dottio123/rustdesk-webui/compare/v1.0.0-rc.1...v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/dottio123/rustdesk-webui/compare/v0.7.0...v1.0.0-rc.1
[0.7.0]: https://github.com/dottio123/rustdesk-webui/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/dottio123/rustdesk-webui/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/dottio123/rustdesk-webui/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/dottio123/rustdesk-webui/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/dottio123/rustdesk-webui/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dottio123/rustdesk-webui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dottio123/rustdesk-webui/releases/tag/v0.1.0
