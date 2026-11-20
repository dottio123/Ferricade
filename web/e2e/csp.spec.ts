// The built app under ferricade's exact Content-Security-Policy (read from
// internal/adminapi/middleware.go) logs no violation on any route.
import { ROUTES } from './support/routes'
import { ferricadeCSP, serveDist, type StaticServer } from './support/server'
import { AUTH_ME_401, expect, mockReady, recordViolations, test } from './support/test'

let server: StaticServer

test.beforeAll(async () => {
  server = await serveDist()
})
test.afterAll(async () => {
  await server?.close()
})

// Ruling F5: index.html responses (any UI path, and /index.html) add a
// style-src with a fresh nonce, which the page reads from its csp-nonce meta.
const INDEX_CSP =
  /^default-src 'self'; style-src 'self' 'nonce-([A-Za-z0-9+/]+={0,2})'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'$/
const META_NONCE = /<meta name="csp-nonce" content="([^"]*)"/

test('the server sends ferricade CSP, with a fresh style nonce on each index.html', async ({
  request,
}) => {
  expect(ferricadeCSP()).toBe(
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  )
  const nonces = new Set<string>()
  let script = ''
  for (const path of ['/devices', '/', '/index.html', '/devices']) {
    const res = await request.get(`${server.url}${path}`)
    const html = await res.text()
    const csp = res.headers()['content-security-policy'] ?? ''
    const nonce = INDEX_CSP.exec(csp)?.[1]
    expect(nonce, `${path}: ${csp}`).toBeDefined()
    expect(Buffer.from(nonce!, 'base64')).toHaveLength(16)
    expect(META_NONCE.exec(html)?.[1], path).toBe(nonce)
    expect(html, path).not.toContain('__FERRICADE_CSP_NONCE__')
    nonces.add(nonce!)
    script ||= /<script type="module" crossorigin src="([^"]+)"/.exec(html)?.[1] ?? ''
  }
  expect(nonces.size).toBe(4)

  // Everything else keeps the plain policy.
  expect(script).toMatch(/^\/assets\//)
  for (const path of [script, '/admin/api/v1/nope']) {
    const res = await request.get(`${server.url}${path}`)
    expect(res.headers()['content-security-policy'], path).toBe(ferricadeCSP())
  }
})

test('the server answers 400 to a path it cannot decode, and keeps serving', async ({
  request,
}) => {
  const bad = await request.get(`${server.url}/devices/%E0%A4%A`)
  expect(bad.status()).toBe(400)
  expect((await request.get(`${server.url}/devices`)).status()).toBe(200)
})

test('no route violates the CSP', async ({ page }) => {
  test.setTimeout(60_000)
  const violations = await recordViolations(page)
  let deviceId = ''
  for (const route of ROUTES) {
    let path = route.path
    if (route.id) {
      await mockReady(page)
      deviceId ||= await page.evaluate(() => window.__ferricadeMock!.approvedDeviceId())
      path = path.replace('$id', deviceId)
    }
    await page.goto(`${server.url}${path}${route.query ? `?${route.query}` : ''}`)
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible()
    expect(await violations(), route.path).toEqual([])
  }
})

test.describe('a signed-out visit to /sign-in', () => {
  // The route list opens /sign-in with a session that has not passed TOTP. The
  // usual arrival is signed out: /sign-in's GET /auth/me answers 401, and
  // Chromium logs that one line.
  test.use({ allowConsoleErrors: [AUTH_ME_401] })

  test('shows the form with no violation', async ({ page }) => {
    const violations = await recordViolations(page)
    const unauthorized: string[] = []
    page.on('response', (res) => {
      if (res.status() === 401) {
        unauthorized.push(`${res.request().method()} ${new URL(res.url()).pathname}`)
      }
    })
    await page.goto(`${server.url}/sign-in?mock-session=signed-out`)
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
    await expect(page.getByLabel('Username')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/sign-in')
    expect(await violations()).toEqual([])
    expect(unauthorized).toEqual(['GET /admin/api/v1/auth/me'])
  })
})

test.describe('the violation check itself', () => {
  // This test causes a violation on purpose.
  test.use({ allowConsoleErrors: [/Content Security Policy/] })

  test('catches an inline script', async ({ page }) => {
    const violations = await recordViolations(page)
    await page.goto(`${server.url}/sign-in?mock-session=mfa`)
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
    await page.evaluate(() => {
      const s = document.createElement('script')
      s.textContent = 'window.__inline = 1'
      document.body.append(s)
    })
    await expect
      .poll(violations)
      .toEqual([expect.stringMatching(/^script-src-elem blocked inline/)])
  })

  // The nonce lets in only the <style> elements that carry it: one without
  // it, and a style attribute (nonces never apply to attributes), are blocked.
  test('catches an inline <style> without the nonce, and a style attribute', async ({ page }) => {
    const violations = await recordViolations(page)
    await page.goto(`${server.url}/sign-in?mock-session=mfa`)
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
    const applied = await page.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = 'body { overflow: hidden !important }'
      document.head.append(style)
      document.body.setAttribute('style', 'visibility: hidden')
      const body = getComputedStyle(document.body)
      return { overflow: body.overflow, visibility: body.visibility }
    })
    expect(applied).toEqual({ overflow: 'visible', visibility: 'visible' })
    await expect
      .poll(violations)
      .toEqual([
        expect.stringMatching(/^style-src-elem blocked inline/),
        expect.stringMatching(/^style-src-attr blocked inline/),
      ])
  })
})
