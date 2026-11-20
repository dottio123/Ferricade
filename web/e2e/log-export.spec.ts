import AxeBuilder from '@axe-core/playwright'
import { expect, test } from './support/test'

const unsavedHint = 'Save changes first to test with updated settings.'

test.describe('Settings → Log Export', () => {
  test('owner can enable the file, test it, and save and test syslog', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    await page.getByRole('link', { name: /Log Export/i }).click()

    await expect(page).toHaveURL(/\/settings\/log-export/)
    await expect(page.getByRole('heading', { level: 1, name: 'Log Export' })).toBeVisible()

    const fileSwitch = page.getByRole('switch', { name: 'Enable log file export' })
    const saveButton = page.getByRole('button', { name: 'Save changes' })
    const testButtons = page.getByRole('button', { name: 'Send test event' })
    const fileTest = testButtons.nth(0)
    const syslogTest = testButtons.nth(1)

    // File on, save, persists across a reload.
    await expect(fileSwitch).not.toBeChecked()
    await fileSwitch.click()
    await expect(fileSwitch).toBeChecked()
    await expect(page.getByText(unsavedHint).first()).toBeVisible()
    await expect(fileTest).toBeDisabled()
    await saveButton.click()
    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: 'Log export settings saved' }),
    ).toBeVisible()
    await expect(page.getByText(unsavedHint)).toHaveCount(0)

    // The mock keeps these settings in memory only (a reload resets them), so leave the page
    // and come back through the app: the form is refetched from the saved settings.
    await page.getByRole('link', { name: 'Settings' }).first().click()
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    await page.getByRole('link', { name: /Log Export/i }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Log Export' })).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Enable log file export' })).toBeChecked()

    // File test shows the ok result.
    await expect(fileTest).toBeEnabled()
    await fileTest.click()
    await expect(page.getByText('Test event delivered')).toHaveCount(1)

    // Syslog host entered: tests disabled with the hint until saved.
    await page.getByLabel('Host').fill('syslog.example.com')
    await expect(syslogTest).toBeDisabled()
    await expect(page.getByText(unsavedHint)).toHaveCount(2)
    await saveButton.click()
    await expect(page.getByText(unsavedHint)).toHaveCount(0)
    await expect(syslogTest).toBeEnabled()

    await syslogTest.click()
    await expect(page.getByText('Test event delivered')).toHaveCount(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('enabling syslog without a host shows the error at the host field', async ({
    page,
    allowConsoleErrors,
  }) => {
    // The refused save is the point of the test; the browser logs its 400.
    allowConsoleErrors.push(
      /status of 400 \(Bad Request\) \(https?:\/\/[^/]+\/admin\/api\/v1\/settings\/log-export\)$/,
    )
    await page.goto('/settings/log-export')
    await expect(page.getByRole('heading', { level: 1, name: 'Log Export' })).toBeVisible()

    await page.getByRole('switch', { name: 'Enable syslog export' }).click()
    await expect(
      page.getByText('Host name or IP address is required when syslog is enabled.'),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Save changes' }).click()

    const hostField = page.getByLabel('Host')
    await expect(hostField).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('alert').filter({ hasText: 'syslog.host' })).toBeVisible()
  })

  test('admin role sees the page read-only', async ({ page }) => {
    await page.goto('/settings/log-export?mock-role=admin')
    await expect(page.getByRole('heading', { level: 1, name: 'Log Export' })).toBeVisible()

    await expect(page.getByText(/Only owners can edit log export settings/i)).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Enable log file export' })).toBeDisabled()
    await expect(page.getByRole('switch', { name: 'Enable syslog export' })).toBeDisabled()
    await expect(page.getByRole('switch', { name: 'Use TLS' })).toBeDisabled()
    await expect(page.getByLabel('Host')).toBeDisabled()
    await expect(page.getByRole('spinbutton', { name: 'Port' })).toBeDisabled()
    await expect(page.getByLabel('CA certificate')).toBeDisabled()
    await expect(page.getByRole('combobox', { name: 'Format' })).toBeDisabled()
    await expect(page.getByRole('combobox', { name: 'Facility' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Send test event' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0)
  })

  test('user role is redirected to /', async ({ page }) => {
    await page.goto('/settings/log-export?mock-role=user')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`zero critical/serious a11y violations in ${theme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/settings/log-export')
      await page.waitForLoadState('domcontentloaded')
      await expect(page.getByRole('heading', { level: 1, name: 'Log Export' })).toBeVisible()
      await page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t)
      }, theme)

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()

      const severe = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      )
      expect(severe).toEqual([])
    })
  }
})
