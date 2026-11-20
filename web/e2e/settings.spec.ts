import { expect, test } from './support/test'

const ALLOWED_ERRORS = /status of 400 \(Bad Request\)/
test.use({ allowConsoleErrors: [ALLOWED_ERRORS] })

test.describe('Settings pages and client config', () => {
  test('loads settings index with navigation cards and Client Configuration', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()

    // Navigation cards
    await expect(page.getByRole('link', { name: /Server Profile/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /Fleet Thresholds/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /Users Manage/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /Client Setup/i })).toBeVisible()

    // Client Configuration
    await expect(
      page.getByRole('heading', { level: 2, name: 'Client Configuration' }),
    ).toBeVisible()
    await expect(page.getByText('Server configuration string')).toBeVisible()
  })

  test('navigates from settings Client Setup card to Client Configuration', async ({ page }) => {
    await page.goto('/settings')
    const clientLink = page.getByRole('link', { name: /Client Setup/i })
    await expect(clientLink).toBeVisible()
    await clientLink.click()

    await expect(page).toHaveURL(/\/settings#client-setup/)
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    await expect(
      page.getByRole('heading', { level: 2, name: 'Client Configuration' }),
    ).toBeVisible()
  })

  test('edits server settings, shows inline invalid_key error, and runs reachability checks', async ({
    page,
  }) => {
    await page.goto('/settings/server')
    await expect(page.getByRole('heading', { level: 1, name: 'Server' })).toBeVisible()

    // 1. Run reachability checks
    const runChecksBtn = page.getByRole('button', { name: 'Run checks' })
    await expect(runChecksBtn).toBeVisible()
    await runChecksBtn.click()

    await expect(page.getByText('Reachability check results:')).toBeVisible()
    await expect(page.getByText('Passing').first()).toBeVisible()

    // 2. Test invalid public key
    const pubKeyInput = page.getByLabel('Public key')
    const originalKey = await pubKeyInput.inputValue()

    await pubKeyInput.fill('invalid-key-not-base64-32-bytes')
    await page.getByRole('button', { name: 'Save changes' }).click()

    await expect(page.getByText('Public key must be base64 of 32 bytes.')).toBeVisible()

    // 3. Restore valid key and update ID host
    await pubKeyInput.fill(originalKey)
    await page.getByLabel('ID server host').fill('hbbs')
    await expect(
      page.getByText(
        "Clients on other machines can't reach hbbs. Use this server's LAN IP or DNS name.",
      ),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Save changes' }).click()

    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: 'Server settings saved' }),
    ).toBeVisible()
    await expect(page.getByText('Reachability check results:')).toHaveCount(0)
  })

  test('updates password and toggles TOTP re-enrollment on account settings', async ({ page }) => {
    await page.goto('/account')
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible()

    // 1. Update password
    await page.getByLabel('Current password').fill('correct horse battery')
    await page.getByLabel('New password', { exact: true }).fill('brandnewpassword123')
    await page.getByLabel('Confirm new password').fill('brandnewpassword123')

    const updateBtn = page.getByRole('button', { name: 'Update password' })
    await expect(updateBtn).toBeEnabled()
    await updateBtn.click()

    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: 'Password updated successfully' }),
    ).toBeVisible()

    // 2. TOTP Re-enrollment
    await expect(page.getByText('Enrolled')).toBeVisible()
    await page.getByRole('button', { name: 'Re-enroll authenticator' }).click()

    await expect(page.getByText('Scan QR code with your authenticator app')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('updates Fleet Thresholds and applies layout presets', async ({ page }) => {
    // 1. Update thresholds on /settings/thresholds
    await page.goto('/settings/thresholds')
    await expect(page.getByRole('heading', { level: 1, name: 'Fleet Thresholds' })).toBeVisible()

    await page.getByLabel('Offline attention threshold (days)').fill('14')
    await page.getByLabel('Pending attention threshold (hours)').fill('48')
    await page.getByLabel('Minimum RustDesk client version').fill('1.4.0')

    await page.getByRole('button', { name: 'Save thresholds' }).click()
    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: 'Dashboard thresholds saved' }),
    ).toBeVisible()

    // 2. Apply presets on /account/dashboard
    await page.goto('/account/dashboard')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard Layout' })).toBeVisible()

    await page.getByRole('button', { name: 'Apply Homelab' }).click()
    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: 'Applied homelab preset' }),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Apply Business' }).click()
    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: 'Applied business preset' }),
    ).toBeVisible()
  })
})
