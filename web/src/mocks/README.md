# Mock API

A stateful mock of the whole admin API (`internal/adminapi/openapi.yaml`), for
`npm run dev`, Vitest and the Playwright flows. It is served by MSW from a
service worker (browser) or `setupServer` (tests). It is never part of
`npm run build`: `scripts/check-dist.mjs` fails the build if MSW, the worker
script or the fixtures appear in `dist/`.

Build with mocks (for e2e and shots): `npm run build:mock` writes `dist-mock/`.

## URL switches

Read from the page's query string in the browser (`src/mocks/config.ts`; tests
call `readMockConfig('?mock=small')` directly).

| Switch                       | Effect                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?mock=small\|medium\|large` | 3, 40 or 400 devices (default `medium`), with sessions, 90 days of snapshots and audit entries                                                                                                                              |
| `?mock-delay=<ms>`           | every response waits this long                                                                                                                                                                                              |
| `?mock-fail=<id>[,<id>]`     | those operations answer 500 `internal` (ids below)                                                                                                                                                                          |
| `?mock-role=admin`           | signed in as an Admin (default Owner): `/users/*`, `PATCH /server` and `PUT /settings/dashboard` answer 403 `forbidden`                                                                                                     |
| `?mock-role=user`            | signed in as the `helpdesk` User (granted one group and one approved device): only the allow-listed operations, scoped to the granted devices; the rest answer 403 `forbidden`, a device outside the grants 404 `not_found` |
| `?mock-grants=none`          | with `mock-role=user`: the helpdesk account starts with no grants (no visible devices, empty lists)                                                                                                                         |
| `?mock-setup=incomplete`     | first-run setup is open: `/setup/status` is false, nobody is signed in, the `/setup/*` wizard works                                                                                                                         |
| `?mock-session=signed-out`   | nobody is signed in (the default is signed in with MFA passed)                                                                                                                                                              |
| `?mock-session=mfa`          | signed in, TOTP not passed yet (the app shows `/sign-in/totp`)                                                                                                                                                              |
| `?mock-session=enroll`       | signed in, TOTP required but not set up (the app shows `/enroll-totp`)                                                                                                                                                      |

Switches combine: `?mock=large&mock-delay=400&mock-fail=listSessions`.

## Controls for the Playwright flows

In the browser the mock also puts `window.__ferricadeMock` (`src/mocks/controls.ts`)
on the page, so a spec can change the "server" while the app runs:
`expireSession()`, `dropEventStreams(ms)`, `takeServerOffline(ms)`, `approvePendingDevice()`,
`approvedDeviceId()`, `moveDevice(deviceId, groupId | null)` (changes a device's group as the
owner would, audited and with its live events, e.g. to take a device out of a User's grants). Call them with
`page.evaluate(() => window.__ferricadeMock!.expireSession())` after
`mockReady(page)` (`e2e/support/test.ts`).
`takeServerOffline(ms)` closes open streams and makes every `/admin/api/v1/*`
request fail as a network error until the mock clock reaches `db.now() + ms`.
It returns `performance.now()` at the drop for timing assertions.

## Demo credentials

| What                                       | Value                                                             |
| ------------------------------------------ | ----------------------------------------------------------------- |
| Owner                                      | `alex`, password `correct horse battery`                          |
| Admin                                      | `sam`, same password (the signed-in user with `?mock-role=admin`) |
| TOTP code                                  | `123456` (any account)                                            |
| TOTP code that answers `code_already_used` | `000000`                                                          |
| Setup token (`X-Setup-Token`)              | `mock-setup-token`                                                |

The mock starts signed in with MFA passed. After `POST /auth/logout`, sign in
again with the credentials above (the login answers `mfa_required: true`, then
`POST /auth/totp`). Five wrong passwords, or five wrong codes, answer 423
`locked` for a minute. State-changing requests need the `X-CSRF-Token` header
that `/auth/me`, `/auth/login` and the other session calls return; the token
changes each time the server says so, as the real one does.

A user created by the setup wizard can sign in with the password chosen there.

## Behaviour

- Stateful: approving a device changes the device list, the summary counts and
  the audit log; groups, tags, users and thresholds persist until the page
  reloads. Dashboard preferences also survive a reload in the same tab
  (sessionStorage, passed in by `startMockWorker`), as on the real server.
- Every change writes an audit entry and emits `LiveEvent`s on
  `GET /admin/api/v1/events` (an SSE stream, `Accept: text/event-stream`).
  In dev, a random approved device also goes online or offline every 20 s.
- Lists use the real pagination (`limit`, `cursor`, `next_cursor`); the device
  `online` filter applies after the page is cut, as in the real API.
- Only authenticated sessions count in the statistics (as in the backend).
- Hosts starting with `down.` fail the server checks (`/server/check`).
- `window.__ferricadeMock.setServerCheck(name, ok, detail?)` changes one check in `GET /server/health`; changing pass/fail updates its `since`, and every call updates `checked_at`.

## Operation ids (for `?mock-fail=`)

The contract has no `operationId`, so `src/mocks/operations.ts` names them:
`login`, `logout`, `me`, `verifyTotp`, `changePassword`, `enrollTotp`,
`verifyEnrollTotp`, `getClientConfig`, `setupStatus`, `setupOwner`,
`setupOwnerTotp`, `setupVerifyOwnerTotp`, `setupServer`, `setupComplete`,
`listDevices`, `getDevice`, `patchDevice`, `approveDevice`, `rejectDevice`,
`archiveDevice`, `restoreDevice`, `resolveAlert`, `connectDevice`,
`listGroups`, `createGroup`, `renameGroup`, `deleteGroup`, `moveGroup`,
`listTags`, `createTag`, `updateTag`, `deleteTag`, `listUsers`, `createUser`,
`patchUser`, `resetUserTotp`, `getServer`, `patchServer`, `checkServer`,
`listAudit`, `listSessions`, `sessionStats`, `statsHistory`, `statsSummary`,
`getDashboardSettings`, `putDashboardSettings`, `dashboardCatalog`, `events`,
`getPreferences`, `putPreferences`.

## For the people changing the mock

- Shapes come from `src/api/schema.d.ts` (`components['schemas']`); a route's
  responder only accepts the statuses and bodies the contract documents for
  that operation, and a request body spec must name exactly the contract's
  fields.
- `handlers.test.ts` loads `openapi.yaml`, calls every operation against the
  `medium` mock and validates each response with Ajv against its schema, so a
  fixture that drifts from the contract fails `npm test`. It also fails when an
  operation has no handler.
- The event stream is a plain `ReadableStream`, not MSW's `sse()`: `sse()` is
  not told when the page closes its `EventSource`, and kept writing to the dead
  stream (an error in the console for every later change).
