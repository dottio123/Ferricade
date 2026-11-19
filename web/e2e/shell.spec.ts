import { expect, test } from './support/test'

const LOGOUT_FAIL = /status of 500 .*\/admin\/api\/v1\/auth\/logout/

test.use({ allowConsoleErrors: [LOGOUT_FAIL] })

test.describe('App shell features', () => {
  test('live indicator reads "Live" and shows status', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const liveIndicator = page.getByRole('status')
    await expect(liveIndicator).toBeVisible()
    await expect(liveIndicator).toHaveText('Live')
  })

  test('theme switch applies dark theme, keeps other preference fields in PUT, and persists across reload', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Capture the PUT request to verify payload integrity
    const putPromise = page.waitForRequest(
      (req) => req.url().includes('/admin/api/v1/me/preferences') && req.method() === 'PUT',
    )

    // Open profile menu, hover Appearance submenu, verify current theme is checked, and choose Dark
    const profileBtn = page.getByRole('button', { name: /Profile/i })
    await profileBtn.click()
    await page.getByRole('menuitem', { name: 'Appearance' }).hover()
    const systemRadio = page.getByRole('menuitemradio', { name: 'System' })
    await expect(systemRadio).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('menuitemradio', { name: 'Dark' }).click()

    // Assert html attribute updated
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // Verify PUT request payload
    const putReq = await putPromise
    const putBody = putReq.postDataJSON()
    expect(putBody.theme).toBe('dark')
    expect(putBody.density).toBeDefined()
    expect(putBody.preset).toBeDefined()
    expect(Array.isArray(putBody.modules)).toBe(true)
    expect(Array.isArray(putBody.pinned_device_ids)).toBe(true)

    // Reload and assert theme persists with radio checked
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await profileBtn.click()
    await page.getByRole('menuitem', { name: 'Appearance' }).hover()
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  test('hides Users link for non-owner role', async ({ page }) => {
    await page.goto('/?mock-role=admin')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Users link should be hidden for admin role
    await expect(page.getByRole('link', { name: 'Users' })).toBeHidden()
  })

  test('displays sign-out failure error when logout fails', async ({ page }) => {
    await page.goto('/?mock-fail=logout')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const profileBtn = page.getByRole('button', { name: /Profile/i })
    await profileBtn.click()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()

    // Error alert is rendered next to the profile button
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('mock-fail: logout')
  })
})
