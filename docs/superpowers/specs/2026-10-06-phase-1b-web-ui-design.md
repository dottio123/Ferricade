1×2 · **2×2** · 2×3| Topic | Decision |
|---|---|
| Users and scale | Small to mid-sized business (50–500 devices, a few admins) as the baseline, scaling down to a homelab. Not sold |
| Analytics | Live fleet state, trends over time, session history, admin activity |
| Session history | Pulled forward from Phase 3: sessions only (open, authenticate, close). File transfers and alarms stay in Phase 3 |
| Look | Dark-first "command center", with an equally polished light theme and follow-system |
| Customization | Toggle and reorder modules; fixed module sizes; presets; per admin, stored on the server |
| Stack | React + TypeScript + Vite, embedded in the Go binary with `go:embed`, same origin |
| Builders | Claude: backend additions, UI foundation, reviews, final gate. Gemini 3.8 in Antigravity: design system and pages, from briefs |

## Scope

### App shell

- A slim left sidebar that collapses to icons.
- A top bar with global search and the account menu.
- **Command palette (Ctrl+K):** search devices by name, alias or ID and press Enter to connect; also jumps to pages and actions.
- **Live updates:** changes arrive in the background and animate in (section "Live updates").
- **Theme:** dark (default), light, or follow system. **Density:** Comfortable (default) or Compact.

### Pages

| Page | Contents |
|---|---|
| Sign-in | Password, then TOTP, as two steps; the forced TOTP enrollment for users with `totp_required` and no TOTP |
| First-run setup | Wizard over `/setup/*`: paste the setup token; create the owner; scan a QR code of `otpauth_url` (generated in the browser) and verify; add the server with live reachability checks; finish on the client-config view: copy buttons, `config_string`, per-OS install commands |
| Command center | The dashboard (next section) |
| Devices | Search, filters (state, online, group, tag, OS), sort; an **Approval queue** tab with single and bulk approve or reject; a detail panel with identity, live status, active sessions, tags, group, alias, notes, uuid-mismatch alerts and their resolution, the device's sessions and audit entries, and connect actions (connect, file transfer, port forward, terminal, force relay) |
| Sessions | History: device, peer, type, start, duration, open or closed; filters by device, time range, active |
| Groups & tags | Group tree (create, rename, move, delete when empty); tags with colors |
| Audit log | Newest first; filters by action, actor and time; readable sentences ("Alice approved plexbox") with the raw details on demand |
| Users | Owner only: list, create, edit, disable, reset TOTP |
| Settings | Server profile and re-run checks; client config and install commands; your account (password, TOTP); dashboard presets; owner thresholds |

### Out of scope

OIDC; per-group roles and grants (Phase 2); address books; webhooks; setup
modes B and C; file-transfer and alarm history (Phase 3); in-browser remote
desktop.

## Command center

The command center is a bento grid: 4 columns of fixed-height rows. Each
module offers its own Small, Medium and Large shapes (columns x rows, from
`GET /dashboard/catalog`), and the user picks one per module; boxes keep the
user's order exactly (no automatic packing), and edit mode shows the grid so
gaps are easy to close. Each module is a card that
answers one question at a glance and links to the page with the detail. A
module with nothing to show collapses to a one-line "all clear" state.

| Module | Answers | Sizes S · M · L (default bold) | Source |
|---|---|---|---|
| `fleet-pulse` | Online of approved with an online-share meter; pending, with how many waited over 24 h; live sessions, with the 24 h peak; open alerts, with the other issues. Each number shows its change vs 24 h ago; no graphs (user decision) | 2×1 · **4×1** | summary + history |
| `quick-connect` | Pinned devices and your recent connects, with live status and one-click connect | 1×2 · **2×2** · 2×3 | preferences + audit (`actor` = you, `device.connect_link`) |
| `approval-queue` | Pending devices; approve or reject inline | 1×2 · **2×2** · 2×3 | devices `state=pending` |
| `needs-attention` | Open uuid mismatches, devices pending over 24 h, long-offline devices, outdated clients | 1×2 · **2×2** · 2×3 | summary |
| `live-sessions` | Open sessions: device, peer, type, ticking duration | 1×2 · **2×2** · 2×3 | sessions `active=true` |
| `activity-trend` | Online devices and active sessions over 24 h / 7 d / 30 d | 2×2 · **4×2** · 4×3 | history |
| `fleet-overview` | Up to 30 approved devices: a tile per device; above that, online/total per group | 2×2 · **4×2** · 4×3 | summary + devices |
| `recent-sessions` | Last 10 sessions with durations | 1×2 · **2×2** · 2×3 | sessions |
| `session-analytics` | Sessions per day, average duration, most-used devices | **2×2** · 4×2 · 4×3 | sessions stats |
| `platform-mix` | OS split and client versions, outdated flagged | 1×2 · **2×2** | summary |
| `admin-activity` | Recent admin actions in plain words; failed sign-ins highlighted | 1×2 · **2×2** · 2×3 | audit |

**Presets.** Choosing a preset replaces the layout; toggling and reordering
then edit it. "Reset to default" returns to Business.

| Preset | Modules, in order |
|---|---|
| Homelab | fleet-pulse, quick-connect, live-sessions, fleet-overview, needs-attention, recent-sessions (all Medium) |
| Business (default) | fleet-pulse, approval-queue, needs-attention, activity-trend, live-sessions, admin-activity, fleet-overview, platform-mix (all Medium) |
| Monitoring wall | fleet-pulse, activity-trend (Large), fleet-overview, live-sessions, session-analytics (Small); larger type, no editing controls, no hover-only information |

**Thresholds** (owner settings, with defaults): long offline after 7 days;
pending too long after 24 h; minimum client version unset (no "outdated"
flag until set).

## Backend additions (Claude, before any UI task)

Each lands with tests and in `openapi.yaml`.

1. **Session ingestion.**
   - **Endpoint:** `POST /api/audit/conn` on the client routes (`wire.ConnAudit`). A client sends three records per connection, sharing `conn_id`: `action: "new"` (with `ip`), a record with `peer` and `type`, and `action: "close"`.
   - **Storage:** a `sessions` row per `(device, conn_id, open)`: `peer_rustdesk_id`, `peer_name`, `type` (0 remote, 1 file transfer, 2 port forward, 3 camera, 4 terminal), `client_ip`, `started_at`, `authed_at`, `ended_at`.
   - **Trust and dedup:** the same identity rules as heartbeat (a known device, uuid matches, state pending or approved; anything else is ignored and answered `{}`). Duplicates are dropped by `nonce`.
   - **Staleness:** a session whose `conn_id` disappears from the device's heartbeat `conns` for more than 60 s is closed, with `ended_at` set to when it was last seen.
   - **Retention:** 365 days.
   - **Admin API:** `GET /sessions` (filters `device_id`, `active`, `since`, `until`; cursor pagination) and `GET /sessions/stats?range=` (per-day counts, average duration, top devices).
   - **Events:** `session.started`, `session.updated` (when the auth record arrives) and `session.ended`.
2. **Trend history.**
   - **Snapshots:** every 5 minutes: approved total, online, pending, active sessions. Kept for 90 days.
   - **Endpoint:** `GET /stats/history?range=24h|7d|30d`, downsampled to 5 min, 1 h and 6 h points.
3. **Summary.** `GET /stats/summary`, one call for the command center:
   - counts by state, online count, active sessions, open alerts;
   - OS mix and client-version mix;
   - online/total per group;
   - the "needs attention" items, each with a kind, a device and a reason.
4. **Preferences.**
   - **Per admin:** `GET` and `PUT /me/preferences` hold `{preset, modules: [{id, enabled, size}] (order = display order; size one of the catalog's sizes for that module), pinned_device_ids, theme, density}`. Validated: unknown module IDs are rejected and the size is capped.
   - **Owner thresholds:** `GET` and `PUT /settings/dashboard`.
5. **Live updates.** `GET /events` is a server-sent event stream on the admin listener:
   - Authenticated by the session cookie, with a heartbeat comment every 25 s.
   - It is exempt from the admin write timeout via `http.ResponseController`, and limited to 5 streams per session.
   - **Event types:** `device.updated`, `device.enrolled`, `device.online`, `device.offline`, `session.started`, `session.updated`, `session.ended`, `audit.created`, `preferences.updated`, and `resync` before the server ends a stream that may have missed events. Each carries only the IDs it concerns; the payload schema is `LiveEvent` in `openapi.yaml`.
6. **Serving.**
   - **Embedding:** the build output of `web/` is embedded and served at `/` on the admin listener; any other file of the build (`favicon.ico`, `robots.txt`, the manifest) is served at its path; unknown non-API paths and folders fall back to `index.html` (folders are never listed).
   - **Caching:** hashed assets (`/assets/*`) get `Cache-Control: public, max-age=31536000, immutable`; `index.html`, every other file and the UI's 404 and 405 get `no-store`.
   - **CSP:** `default-src 'self'`, … as before, except that each `index.html` response carries a fresh style nonce: `style-src 'self' 'nonce-<16 random bytes, base64>'`, with the same nonce in `<meta name="csp-nonce">` (Radix's scroll lock adds a `<style>` at runtime). Scripts stay `'self'`, style attributes stay blocked, and every other response keeps the plain policy (Ruling F5, docs/phase-1b-web-notes.md).
   - **Dev builds:** without a UI build present, `/` answers a short text page saying how to build the UI.
7. **Contract test.** Every admin API test response is validated against its `openapi.yaml` response schema, not just its route. Schemas mark required fields and use `additionalProperties: false` where the shape is closed.

## Web foundation (Claude)

`web/` (npm workspace root), built by CI and embedded by the Go build.

- **Tooling:** Vite, React 19, TypeScript in strict mode, ESLint, Prettier, Vitest with Testing Library, Playwright.
- **API client:**
  - `openapi-typescript` generates `src/api/schema.d.ts` from `internal/adminapi/openapi.yaml` (`npm run gen:api`). CI fails when the generated file is stale.
  - All calls go through `openapi-fetch` typed by that schema. A call to a path or field that is not in the contract fails `npm run typecheck`.
- **The single request wrapper:**
  - Same-origin, sending the session cookie.
  - On unsafe methods it sends `X-CSRF-Token` from memory (never `localStorage`) and the browser's own `Origin`.
  - It stores the new CSRF token after sign-in, TOTP and password changes.
  - On 401 it routes to sign-in. Error bodies are mapped to a typed `ApiError {status, code, message}`.
- **Mocks:** MSW handlers typed from the same schema, with realistic fixtures: 3, 40 and 400 devices, sessions and audit entries. `npm run dev` uses the mocks; `npm run dev:live` proxies to a real rdadmin.
- **Router and data:** TanStack Router (file-based) with an auth guard and setup detection, and TanStack Query.
- **Live updates:** an `EventSource` hook that invalidates the affected queries. When the stream fails it falls back to a 15 s refetch interval.
- **Scripts:** `npm run typecheck`, `lint`, `test`, `build`, `e2e`, and `shots`. `shots` is Playwright screenshots of every page in both themes at 1440×900 and 390×844, saved to `web/shots/`, for the user's own visual reviews. Agents do not open screenshots or drive a browser, to save tokens; they verify with text checks.

## Design language

Gemini designs the details; these are the direction and the guardrails.

- **Feel:**
  - A calm, confident command center.
  - Dark graphite surfaces; depth from subtle elevation and soft borders, not heavy shadows.
  - **One** accent color for focus and primary actions.
  - Generous space at Comfortable density, tighter at Compact.
  - Every visual element carries information.
- **Status colors:**
  - online: green;
  - pending: amber;
  - offline: neutral grey (normal, not alarming);
  - alert: red;
  - live session: the accent.
  - Never color alone; always an icon or label too. WCAG AA contrast in both themes.
- **Motion:**
  - 150–250 ms transitions, and springs for layout and reordering.
  - One soft pulse when something changes state; ticking counters and live timers.
  - Every animation explains a change or confirms an action, and all of it is off under `prefers-reduced-motion`.
- **Type:** a modern sans (Inter or Geist) and a monospace for IDs and keys, with tabular figures. Fonts and icons (Lucide) are self-hosted; the UI makes no requests to other origins.
- **States:**
  - Loading uses skeletons, not spinners.
  - Empty states say what to do next.
  - Errors appear inline with a retry.
  - Relative times, with the exact time on hover or focus.
- **Accessibility:** full keyboard use, visible focus, the Ctrl+K palette, and live regions for status changes.
- **Responsive:** the full experience on desktop. On tablets and phones the priority is checking status, approving devices and tapping connect links.
- **Approved libraries:** shadcn/ui (Radix), Tailwind CSS, Motion, Recharts, dnd-kit, TanStack Query and Router, openapi-typescript and openapi-fetch, MSW, Vitest, Playwright, Lucide, qrcode (for the TOTP QR).
  - Anything else needs a stated reason in the task report.
  - No CSS-in-JS that injects `<style>` elements. A library that adds a `<style>` at runtime must put the page's nonce on it (`cspNonce()`; Radix gets it through get-nonce), or the CSP blocks it.
  - No analytics or telemetry.

## Gemini workflow

Each Gemini task is a brief in `docs/superpowers/plans/` (the UI plan) with:
the goal, the files it may touch, the endpoints it uses with example
responses, a "done when" list, what is out of scope, and when to stop and
report. `GEMINI.md` holds the standing rules.

**Antigravity commands** (stock; the table in `GEMINI.md` is binding):
- `/plan` at the start of every task.
- `/grill-me` only in the design-system task, to align with the user on the visual direction.
- `/browser` is not used by default (token cost); the user does visual reviews at the checkpoints and whenever they choose.
- `/boost` for genuinely hard logic, and as the single escalation after a check fails twice. If it still fails, stop and report.
- `/learn` after Claude's review corrections, so they stick. Captured rules may not contradict `GEMINI.md` or `AGENTS.md`.
- `/goal` only for narrow mechanical work with an objective check.
- `/teamwork-preview` and `/schedule` are not used.
- **Terminal:** the brief's verification commands, run after each step, with the output in the report.
- **Image generation:** only during the design-system task and only if the user asks, to explore mood directions. Never as shipped assets.

**Task order:**
1. Design system: tokens (color, type, spacing, radius, motion), both themes, styled core components, and a kitchen-sink page. **User checkpoint.**
2. App shell, sign-in and TOTP flows.
3. First-run setup wizard.
4. Devices: list, approval queue, detail panel, connect actions.
5. Command center: modules, presets, toggle and reorder. **User checkpoint.**
6. Sessions and the audit log.
7. Groups and tags, users, settings.
8. Polish: command palette, live-update animations, responsive and accessibility passes.

After each task, Claude reviews before the next starts:
- API calls against the contract;
- typecheck, lint, tests and build, run by Claude;
- the diff, for invented fields, silent mocks, placeholder logic and churn.

Visual quality is reviewed by the user, not by agents (screenshots cost tokens).

Findings go back as concrete fixes.

## Testing and the gate

- **Backend:** as Phase 1a; plus the contract-schema test, ingestion tests from the derived `audit-conn-*` fixtures, the stale-session close, history downsampling, preferences validation, and SSE (authentication, the stream cap, and an event after a device change).
- **UI:** Vitest for components and hooks; the MSW-backed Playwright flows for every page; and the user's own visual review at each checkpoint (`npm run shots` or `npm run dev`).
- **Gate (Claude):** Playwright against a real rdadmin and Postgres:
  1. setup in the browser;
  2. a simulated device (`rdsim`) appears live on the command center;
  3. approve it;
  4. a quick-connect link includes `@<host>?key=`;
  5. a posted `audit/conn` session appears in live sessions.

  Then the same flow by hand with a real RustDesk client, followed by Claude's cleanup pass over `web/`.
