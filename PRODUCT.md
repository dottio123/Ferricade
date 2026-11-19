# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

System administrators and IT operators managing remote fleets for small to mid-sized businesses (50–500 devices, a few admins) and homelab operators self-hosting their remote desktop infrastructure.

## Product Purpose

ferricade provides a self-hosted admin console and API server for stock RustDesk clients (tested with 1.5.0+) alongside an unmodified RustDesk server (`hbbs`/`hbbr`). It enables administrators to track fleet presence, manage an approval queue for reporting devices, monitor active remote sessions, inspect an append-only audit trail, and launch remote connections with one-click `rustdesk://` links without relying on proprietary third-party cloud services.

## Positioning

An open-source, self-hosted admin and fleet management console that answers stock RustDesk client API endpoints natively. Unlike third-party forks or commercial SaaS offerings, ferricade requires zero modifications to official client binaries or core relay infrastructure (`hbbs`/`hbbr`). It is strictly independent and not affiliated with or endorsed by Purslane Ltd or the RustDesk project.

## Operating Context

- Environments: Deployed via Docker Compose on Linux or local server environments, placed behind an HTTPS reverse proxy (e.g. Caddy, Nginx).
- Workflows: First-run setup wizard via browser, device enrollment and approval queues, one-click remote desktop dispatch (`rustdesk://`), remote session tracking, and append-only audit inspections.
- Usage scenes: Desktop admin console and multi-column "command center" dashboard, supporting dark/light themes, comfortable/compact density, and wall-display monitoring modes.

## Capabilities and Constraints

- Client API compatibility: Implements client-facing HTTP endpoints (`/api/heartbeat`, `/api/sysinfo`, `/api/audit/conn`) on port 21114 matching RustDesk client specifications.
- Admin API & Live Events: Implements admin REST API on port 21120 with Server-Sent Events (`/admin/api/v1/events`) backed by Postgres `LISTEN/NOTIFY`.
- Strict Security: Enforces `__Host-` session cookies (HttpOnly, Secure, SameSite=Strict), per-session CSRF token headers, origin verification on mutations, and strict Content Security Policy (per-response style nonces, no inline scripts, no runtime style attributes).
- External Integrations: Architectural scope must accommodate future external OIDC / SSO identity provider integrations.
- No Traffic Interception: ferricade manages authentication, state, and coordination; peer-to-peer and relayed screen/data connections flow directly through `hbbs` and `hbbr`.

## Brand Commitments

- Name: ferricade (lowercase).
- Independent & Open Source: Clearly marked as unaffiliated with and not endorsed by Purslane Ltd or RustDesk.
- No secrets in repositories, audit logs, or error responses.

## Evidence on Hand

- Specification: `docs/superpowers/specs/2026-10-06-phase-1b-web-ui-design.md` and Phase 1a backend design notes.
- API Contract: OpenAPI specification at `internal/adminapi/openapi.yaml`.
- Verified Backend: Phase 1a Go server, database migrations (`internal/store/migrations`), and end-to-end integration test suite.
- Working UI: React + TypeScript + Vite frontend in `web/` with TanStack Router, Tailwind CSS, and shadcn/Radix components.

## Product Principles

1. Zero Client Modification: Work seamlessly with stock RustDesk client releases without custom patches or custom builds.
2. Uncompromising Security & Auditability: Every state-changing admin action is audited in an append-only transaction; secure defaults are never bypassed.
3. Clarity and Operational Speed: Glanceable fleet status ("command center") designed for fast operator decision-making and one-click connection workflows.
4. Clean Separation of Concerns: Admin orchestration and device tracking remain cleanly separated from the actual media/data relays (`hbbs`/`hbbr`).

## Accessibility & Inclusion

- WCAG 2.1 AA standard across all console surfaces.
- Full keyboard navigation (command palette Ctrl+K, skip link, logical focus management).
- Contrast-verified design tokens across dark and light themes.
- Respects `prefers-reduced-motion` for all status indicators, notifications, and layout animations.
