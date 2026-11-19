# web/src: how the app is wired

## Routes (`routes/`, TanStack Router, file-based)

Each file in `routes/` is a route; `routeTree.gen.ts` is generated from them by
the Vite plugin (`npm run dev` or `npm run build`). It is committed so that
`typecheck` works; never edit it by hand, and commit it with the route change.

| Route                                                                       | File                      | Who                                                    |
| --------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------ |
| `/first-run`                                                                | `first-run.tsx`           | only while setup is open (every other page goes there) |
| `/sign-in`, `/sign-in/totp`                                                 | `sign-in/`                | anyone; the TOTP step needs a session                  |
| `/enroll-totp`                                                              | `enroll-totp.tsx`         | a session that must set up TOTP                        |
| `/`, `/devices`, `/devices/$id`, `/devices/queue`, `/sessions`, `/audit`, … | `_app/…`                  | signed in, TOTP passed (`_app.tsx` guards them)        |
| `/settings/users`                                                           | `_app/settings/users.tsx` | Owner; an Admin sees "Only owners can manage users."   |
| `/dev/kitchen-sink`                                                         | `dev/kitchen-sink.tsx`    | dev server and mock build only                         |

No UI route may start with `/setup`, `/api`, `/admin/api` or `/healthz`: those
paths are the backend's.

`_app.tsx` is the app shell: its `beforeLoad` is the auth guard, and it mounts
`useLiveEvents()` once. Pages render inside its `<Outlet />`.

## Auth (`auth/`)

- `useMe()`: the signed-in user (`GET /auth/me`); always loaded under `_app`.
- The guards (`guard.ts`) run in `beforeLoad`: no session → `/sign-in?next=<page>`;
  TOTP not passed → `/sign-in/totp?next=…`; TOTP to set up → `/enroll-totp?next=…`.
- Any 401 from any API call goes to `/sign-in?next=<page>` (`unauthorized.ts`)
  and forgets the cached data of that session.
- A 403 `mfa_required` or `totp_enroll_required` mid-session (for example after
  an owner reset the user's TOTP) re-runs the guard, which sends the user to
  `/sign-in/totp` or `/enroll-totp` with `?next=`. Pages need nothing for it.
- A 403 `csrf` (the token was rejected) refetches `GET /auth/me`, which brings
  the current token. The request is not retried: its error reaches the caller.
- The CSRF token is read only from the responses that carry one (`/auth/login`,
  `/auth/me`, `/auth/totp`, `/auth/password`, `/auth/totp/enroll/verify`; the
  list in `api/client.ts` is checked against the contract by typecheck).
- `api` has no setup wizard paths (only `GET /setup/status`); the wizard uses
  `setupClient(token)`.
- `/sign-in` sends a fully signed-in user on to `?next=`; signing in forgets
  everything the previous session cached, as a 401 does.
- `?next=` is only ever followed through `safeNext()` (`next.ts`): a path of
  this app, never another origin.
- `useSignIn(next)`, `useVerifyTotp(next)`, `useSignOut()` (`signIn.ts`) do the
  steps; after each one the guard decides where the user lands.
- `<OwnerOnly action="…">` wraps Owner-only content.

## Device panel (`components/devices/device-panel.tsx`)

Every signed-in page can show a device's detail panel over itself: the app shell
reads `?device=<id>` and renders it, so the page underneath keeps its filters and
scroll position, and Back, Escape or the close button return to it. Show a
device's name with `<DeviceLink deviceId={id}>` (`components/devices/device-link.tsx`),
never a link to `/devices`; `/devices/$id` stays as the full page for direct links.
The panel is modal: in tests, the page under it is hidden from role queries.

## Query keys (`lib/queryKeys.ts`)

Every query key comes from `queryKeys`; never write a key inline. The live
updates invalidate keys by their first element, so a page whose key is not
from `queryKeys` will not refresh live.
Every entry is a function (`queryKeys.devices.all()`, `queryKeys.device(id)`),
its arguments typed from the contract's query parameters; a new entry follows
the same shape.

```ts
useQuery({
  queryKey: queryKeys.devices.list({ state: 'pending' }),
  queryFn: ({ signal }) =>
    unwrap(api.GET('/admin/api/v1/devices', { params: { query: { state: 'pending' } }, signal })),
})
```

Infinite queries take keys only from `*.infinite()`; a plain list never
shares its key. (`devices`, `sessions` and `audit` have one; it keeps the
root, so live updates reach it, and leaves out the cursor, the page param.)

```ts
useInfiniteQuery({
  queryKey: queryKeys.devices.infinite({ state: 'approved' }),
  initialPageParam: '',
  queryFn: ({ pageParam, signal }) =>
    unwrap(
      api.GET('/admin/api/v1/devices', {
        params: { query: { state: 'approved', ...(pageParam ? { cursor: pageParam } : {}) } },
        signal,
      }),
    ),
  getNextPageParam: (page) => page.next_cursor || undefined,
})
```

## Mutations and errors

A change is usually a `useMutation` whose `mutationFn` unwraps an `api` call.
The CSRF header is added by the client. On success, invalidate what changed
through `queryKeys` (the live event follows, but this shows the change at once).
Approvals use the shared hook so every approval offers Undo:

```ts
const approveDevices = useApproveDevices()
await approveDevices.approve([device])
```

Show a failed query or mutation with `describeError` (`api/errors.ts`): it
gives the contract's error `code` (or `'network'`, `'unknown'`) to branch on,
a plain `message`, and the `requestId` of an `internal` error to quote.

```tsx
if (approve.isError) {
  const { code, message, requestId } = describeError(approve.error)
  return (
    <p role="alert">
      {code === 'bad_transition' ? 'This device was already handled.' : message}
      {requestId && <> (request {requestId})</>}
    </p>
  )
}
```

## Live updates (`live/`)

`GET /admin/api/v1/events` is open while the shell is mounted. Each event
invalidates the keys in `LIVE_INVALIDATIONS` (`live/invalidation.ts`):

| Event                                    | Invalidates                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `device.updated/enrolled/online/offline` | `['devices']`, `['summary']`, `['device', id]`, `['sessions']`, `['session-stats']` (they show device names) |
| `session.started/updated/ended`          | `['sessions']`, `['summary']`, `['session-stats']`                                                           |
| `audit.created`                          | `['audit']`                                                                                                  |
| `preferences.updated`                    | `['preferences']`                                                                                            |
| `resync`                                 | everything, once the stream is back                                                                          |

- Invalidations are debounced (250 ms per key): a burst of events refetches once.
- While the stream is down, those queries are refetched every 15 s; when it is
  back, everything is refetched once (events may have been missed).
- `useLiveStatus()` is `'live'` with the stream; after 10 s without it, the
  server probe sets `'reconnecting'` or `'offline'`. The shell shows it.
- A page needs nothing for this: key its queries with `queryKeys`.

## Appearance (`lib/appearance.ts`)

The tokens key off two attributes on `<html>`: `data-theme` (`dark` or
`light`; absent means `system`, which follows `prefers-color-scheme`) and
`data-density` (`comfortable` or `compact`).

- `applyAppearance({ theme, density })` sets both and caches them in
  `localStorage`. Call it whenever the user changes them, and after loading
  `GET /me/preferences`: the server is the source of truth, the cache only
  serves the next first paint.
- `public/theme.js` (loaded by `index.html` before the app) applies the cache,
  so there is no flash. Do not move it inline: the CSP blocks inline scripts.
- These two files are the only code allowed to use `localStorage` outside the
  API client and the live stream (`eslint.config.js`).

## CSP and runtime styles (`lib/cspNonce.ts`)

Ferricade's CSP is `default-src 'self'`: no inline script, no inline style. The
one exception (Ruling F5): each index.html response carries a fresh nonce, in
`<meta name="csp-nonce">` and in that response's `style-src`, so a `<style>`
element that carries it is applied. Style attributes stay blocked (React's
`style` prop is fine: it sets properties, not the attribute).

- `main.tsx` passes `cspNonce()` to get-nonce's `setNonce` before rendering;
  Radix's scroll lock (react-style-singleton) reads it from there.
- Any other library that adds `<style>` elements must take the nonce, or be
  reported before it is used. Never `'unsafe-inline'`.
- `cspNonce()` is `undefined` on the dev server (no CSP; the placeholder is
  not filled in). `e2e/support/server.ts` fills it in as Ferricade does, and
  `scripts/check-dist.mjs` fails a build whose index.html lacks the placeholder.

## Tests

- `npm test`: Vitest (unit tests, the router and guard against the mock API).
- `npm run e2e`: builds the production app (`dist/`) and the mock app
  (`dist-mock/`), then runs Playwright (`e2e/`) under Ferricade's CSP: the
  flows against the mock app; for the production build, a check that it has
  no mock code or dev-only page, and a sign-in smoke test with the API
  stubbed. Use `test` and `expect` from `e2e/support/test.ts`: a console
  error (a CSP violation included) fails the test.
- `npm run shots`: screenshots of every route for the user's reviews.
