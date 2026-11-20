// Signing out goes straight to the sign-in form: not through the command
// center (whose calls would answer 401 and bounce back to sign-in).
import type { Request } from '@playwright/test'
import { AUTH_ME_401, expect, test } from './support/test'

// /sign-in asks the server whether someone is still signed in (a signed-in
// user is sent on). After sign-out that GET /auth/me answers 401, and Chromium
// logs it: that one line is expected, nothing else.
test.use({ allowConsoleErrors: [AUTH_ME_401] })

test('signing out from the command center lands on the sign-in form', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

  const visited: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname)
  })
  // Only what the page asks once the logout request is sent counts: a command
  // center fetch already in flight (its summary, a live-event refetch) may
  // still answer after the click, and says nothing about sign-out.
  const LOGOUT = 'POST /admin/api/v1/auth/logout'
  const line = (req: Request) => `${req.method()} ${new URL(req.url()).pathname}`
  const afterLogout = new Set<Request>()
  page.on('request', (req) => {
    if (afterLogout.size > 0 || line(req) === LOGOUT) afterLogout.add(req)
  })
  const unauthorized: string[] = []
  page.on('response', (res) => {
    if (afterLogout.has(res.request()) && res.status() === 401)
      unauthorized.push(line(res.request()))
  })

  const profileBtn = page.getByRole('button', { name: /Profile/i })
  await expect(profileBtn).toBeVisible()
  await profileBtn.click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
  await expect(page.getByLabel('Username')).toBeVisible()
  // Give a bounce (a redirect, a refetch, a 401) time to show.
  await page.waitForTimeout(1_000)

  expect(new URL(page.url()).pathname).toBe('/sign-in')
  expect(visited).not.toContain('/')
  const requests = [...afterLogout].map(line)
  expect(requests[0]).toBe(LOGOUT)
  expect(requests).not.toContain('GET /admin/api/v1/stats/summary')
  expect(unauthorized).toEqual(['GET /admin/api/v1/auth/me'])
})
