// The production bundle (web/dist, the one embedded in the Go binary) starts
// under ferricade's CSP and shows sign-in. It has no mock API, so the calls a
// signed-out visit makes are stubbed with page.route: setup is complete,
// nobody is signed in, and OIDC is off. Any other backend call reaches the static server, which
// answers 404, and the console guard fails the test. The static server fills in
// index.html's style nonce as ferricade does (Ruling F5), so the bundle runs under
// the CSP an index.html response really carries.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveDist, type StaticServer } from './support/server'
import { AUTH_ME_401, expect, recordViolations, test } from './support/test'

const DIST = join(fileURLToPath(new URL('../', import.meta.url)), 'dist')

let server: StaticServer

test.beforeAll(async () => {
  server = await serveDist({ dir: DIST })
})
test.afterAll(async () => {
  await server?.close()
})

// GET /auth/me answers 401 on purpose, and Chromium logs that one line.
test.use({ allowConsoleErrors: [AUTH_ME_401] })

test('the production build shows the sign-in form with no console error or CSP violation', async ({
  page,
}) => {
  const violations = await recordViolations(page)
  await page.route('**/setup/status', (route) => route.fulfill({ json: { setup_complete: true } }))
  await page.route('**/admin/api/v1/auth/me', (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: 'unauthenticated', message: 'not signed in' } },
    }),
  )
  await page.route('**/admin/api/v1/auth/oidc', (route) =>
    route.fulfill({ json: { enabled: false, display_name: '' } }),
  )

  const res = await page.goto(`${server.url}/devices`)
  const csp = res?.headers()['content-security-policy'] ?? ''
  const nonce = /^default-src 'self'; style-src 'self' 'nonce-([^']+)';/.exec(csp)?.[1]
  expect(nonce, csp).toBeDefined()
  await expect(page.locator('meta[name="csp-nonce"]')).toHaveAttribute('content', nonce!)

  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
  await expect(page.getByLabel('Username')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  const url = new URL(page.url())
  expect(url.pathname).toBe('/sign-in')
  expect(url.searchParams.get('next')).toBe('/devices')
  expect(await violations()).toEqual([])
})
