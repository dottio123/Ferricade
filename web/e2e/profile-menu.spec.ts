import type { Request } from '@playwright/test'
import { AUTH_ME_401, expect, test } from './support/test'

test.use({ allowConsoleErrors: [AUTH_ME_401] })

test.describe('Profile menu and navigation', () => {
  test('header no longer has Sign out, Client Setup or the theme toggle', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const header = page.locator('header')
    await expect(header.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
    await expect(header.getByRole('link', { name: 'Client Setup' })).toHaveCount(0)
    await expect(header.getByRole('button', { name: 'Toggle theme' })).toHaveCount(0)
  })

  test('profile menu opens from the sidebar, has User settings, Appearance and Sign out, and signs out', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const visited: string[] = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname)
    })
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

    const profileTrigger = page.getByRole('button', { name: /Profile/i })
    await expect(profileTrigger).toBeVisible()
    await profileTrigger.click()

    await expect(page.getByRole('menuitem', { name: 'User settings' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Appearance' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible()

    await page.getByRole('menuitem', { name: 'Sign out' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
    await expect(page.getByLabel('Username')).toBeVisible()

    await page.waitForTimeout(1_000)
    expect(new URL(page.url()).pathname).toBe('/sign-in')
    expect(visited).not.toContain('/')
    const requests = [...afterLogout].map(line)
    expect(requests[0]).toBe(LOGOUT)
    expect(requests).not.toContain('GET /admin/api/v1/stats/summary')
    expect(unauthorized).toEqual(['GET /admin/api/v1/auth/me'])
  })

  test('keyboard: profile menu opens with Enter, Escape closes it and focus returns to the profile button', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const profileTrigger = page.getByRole('button', { name: /Profile/i })
    await profileTrigger.focus()
    await expect(profileTrigger).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitem', { name: 'User settings' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: 'User settings' })).toHaveCount(0)
    await expect(profileTrigger).toBeFocused()
  })
})
