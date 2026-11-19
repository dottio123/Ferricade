# RD Commander: roadmap (decomposition)

Status: agreed with the user on 2026-10-14 (Project Lead 7). This is not a spec. It splits the idea
into sub-projects and orders them; each sub-project gets its own spec, plan and tasks.

## Purpose (from the user)

rdadmin grows into **RD Commander**, one console for remote access across protocols:

- **Reach servers via the browser:** admins open RDP and VNC sessions to machines on the network
  from a browser anywhere, without a VPN or a local client. rdadmin is the gateway.
- **One console for all:** RustDesk workstations and RDP/VNC machines (servers, appliances, VMs) live
  in one inventory with the same groups, tags, grants and audit log, whichever protocol connects.
- **Replace RustDesk where it isn't wanted:** servers and locked-down hosts are reached over RDP/VNC.
- **Users get access too:** Users (the role) connect to their granted machines through the browser.

Reach: every target is reachable from the rdadmin server today (one network, or sites already routed).
Remote sites come later; nothing may be designed into a dead end for them.

## Core approach

A protocol engine runs as a separate container next to rdadmin and speaks RDP and VNC to the targets
(the open-source `guacd` daemon from Apache Guacamole is the intended engine, run unmodified from its
official image; Apache-2.0). rdadmin
carries each session between the browser and the engine over a WebSocket and does all access control,
auditing and session history itself. The browser renders sessions with **our own display library**
(user ruling, 2026-10-14): written from the engine's protocol documentation, not ported from
Guacamole's JavaScript client, so that it can improve on it. Nothing else from the Guacamole project
(its Java web application, database, user model, terms or UI) is used.

Rejected: implementing RDP/VNC ourselves (far too large); bundling a complete third-party remote-access
web application (two consoles, the opposite of the purpose).

**Our own design and names (user ruling):** the engine is an implementation detail, like Postgres.
rdadmin's API, data model, UI and docs use rdadmin's own terms, never the engine's (no "connection
groups", "tunnels", "guacamole" or similar in the contract or the UI). Each spec defines its terms.

**Each protocol can be switched off entirely (user ruling, 2026-10-14):** some organisations will not
allow RDP or VNC at all. Each protocol has its own deployment setting in `deploy/.env` (names follow the
existing settings, e.g. `RDP_ENABLED`, `VNC_ENABLED`), **off by default**. A disabled protocol is
absent, not hidden: its API endpoints answer as if they did not exist, the UI shows no trace of it,
inventory entries of that protocol cannot be created, and the gateway refuses its sessions. With both
off, the engine container is not needed: it lives in its own compose add-on file (like
`deploy/compose.rustdesk.yml`) that such deployments simply leave out. Every sub-project's spec states
how it honours these settings, and its tests cover the disabled case.

## Sub-projects, in order

1. **Inventory.** RDP and VNC machines in the device inventory (name, host, port, protocol), under
   the same groups, tags, grants and audit as RustDesk devices; a RustDesk device can also carry an
   RDP/VNC address. Useful on its own before any gateway: one inventory, plus a downloadable `.rdp`
   file or a `vnc://` link for admins.
2. **Credential vault.** Encrypted credentials per machine or per group, used by the gateway so that
   Users never see passwords. Shared foundation with Deployment Assist's fleet password and the
   "inject device passwords when admins connect" idea.
3. **Display library.** Our own browser renderer for the engine's drawing, input and clipboard
   instructions, with its own tests against recorded sessions; built and tested before the gateway uses
   it. Its spec collects the improvements to aim for.
4. **Gateway.** The engine container, the WebSocket session path, per-session permission checks
   (Users only reach granted machines), sessions in the history and the audit log, and the browser
   viewer (using the display library) for RDP and VNC. The heart of the project and its main security review (internet-facing).
5. **Clipboard and file transfer.** Enabled per machine or group by policy.
6. **RD Commander rebrand.** Name, UI and docs, once the features justify it.
7. **Sites.** A gateway at a remote site that connects outbound to rdadmin. Later.

Next step: a brainstorming session and spec for sub-project 1 (Inventory).
