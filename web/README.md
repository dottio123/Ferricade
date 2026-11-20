# Ferricade web console

The admin UI: React 19, TypeScript, Vite, Tailwind v4 and shadcn/ui, with
TanStack Router and Query. It talks only to the admin API, whose contract is
[`internal/adminapi/openapi.yaml`](../internal/adminapi/openapi.yaml). The
production build (`web/dist`) is embedded into the `ferricade` binary and served
at `/` on the admin listener.

Node 24 and npm 11. All commands run in `web/`.

## Start with the mock API

No backend needed: a stateful mock of the whole API runs in the browser.

```sh
npm ci
npm run dev            # http://localhost:5173, signed in as the Owner "alex"
```

Add switches to the URL to change what the mock does, for example
`/?mock=large&mock-delay=400` (400 devices, slow answers) or
`/?mock-session=signed-out` (start at the sign-in page). The switches, the
demo credentials (password `correct horse battery`, TOTP `123456`) and the
mock's behaviour are in [`src/mocks/README.md`](src/mocks/README.md).

`/dev/kitchen-sink` shows the design system's parts (dev server and mock build
only).

## Point at a real Ferricade

```sh
cp .env.example .env.local   # set FERRICADE_URL
npm run dev:live
```

`FERRICADE_URL` must equal that server's `PUBLIC_URL`, and the server must run
with `DEV_INSECURE=1`: the dev proxy sends that origin, and Ferricade checks it
on every state-changing request. Sign in with a real account. If a request
is refused, fix the setup, not the check.

The proxy rewrites `Origin` to `FERRICADE_URL` on every request, so Ferricade's
Origin check no longer protects anything that reaches the dev server (the
session cookie's SameSite=Strict and the CSRF token still do). Keep it on
localhost: **never run `dev:live` with `--host`** or set `server.host`.

## Scripts

| Command                 | What                                                                           |
| ----------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`           | Dev server with the mock API                                                   |
| `npm run dev:live`      | Dev server proxied to a real Ferricade (`FERRICADE_URL`)                       |
| `npm run gen:api`       | Regenerate `src/api/schema.d.ts` from `openapi.yaml` (after a contract change) |
| `npm run gen:api:check` | Fail if `schema.d.ts` is out of date (CI runs it)                              |
| `npm run typecheck`     | `tsc -b`                                                                       |
| `npm run lint`          | ESLint                                                                         |
| `npm test`              | Vitest: unit tests, the router and guards against the mock API                 |
| `npm run build`         | Production build to `dist/`, then `check-dist` (no mocks, CSP-safe output)     |
| `npm run build:mock`    | Build with the mock API to `dist-mock/` (for e2e and shots; never embedded)    |
| `npm run e2e`           | Playwright (Chromium) against the mock build, under Ferricade's CSP            |
| `npm run shots`         | Screenshots of every page, both themes, two widths, to `shots/` (for people)   |

All of `typecheck`, `lint`, `test`, `build` and `e2e` must pass before a change
is done.

## Rules that the build enforces

- **Only the contract.** API types come from `schema.d.ts`, generated from
  `openapi.yaml`; the client refuses invented paths, fields and other origins
  at typecheck. A field the UI needs and the contract lacks is a backend change
  first.
- **No mocks in production.** MSW, its worker and the fixtures load only in
  dev and the mock build; `check-dist` fails the build if any reach `dist/`.
- **CSP-safe.** Ferricade serves the UI under a strict Content Security Policy:
  scripts only from the app's own files, no `data:` URLs, and no inline
  styles except `<style>` elements carrying the per-response nonce (read it
  with `cspNonce()` from `src/lib/cspNonce.ts`; Radix gets it automatically).
  `check-dist` and the e2e specs check it.
- **Guardrails in lint.** App code may not call `fetch`, `EventSource` or
  browser storage directly, or import the mocks; ESLint fails the build.
- **Query keys** come from `src/lib/queryKeys.ts`, or live updates will not
  reach the page.

How the app is wired (routes, auth guards, live updates, tests):
[`src/README.md`](src/README.md).
