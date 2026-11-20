// Phase 1b C3 cleanup: behaviour the review found missing (names screen
// readers need, failures that were silent, errors shown as "nothing here").
import { expect, mockReady, test } from './support/test'

test.describe('accessible names', () => {
  test('the two-factor switch in the user dialogs is named by its label', async ({ page }) => {
    await page.goto('/settings/users')
    await page.getByRole('button', { name: 'New user' }).click()
    await expect(
      page.getByRole('switch', { name: 'Require two-factor authentication' }),
    ).toBeVisible()
  })

  test('each device row says its status in text, not only as a colour', async ({ page }) => {
    await page.goto('/devices?state=approved&online=true')
    const row = page.locator('[data-slot="devices-table"] tbody tr').first()
    await expect(row).toBeVisible()
    await expect(row.getByText('Online', { exact: true })).toBeAttached()
  })
})

test.describe('failed actions say so', () => {
  test.use({ allowConsoleErrors: [/status of 500/i] })
  const toastTitle = (page: import('@playwright/test').Page, text: string) =>
    page.locator('[data-slot="toast-title"]').getByText(text, { exact: true })

  test('a failed approve in the device panel shows an error', async ({ page }) => {
    await page.goto('/devices?state=pending&mock-fail=approveDevice')
    await page.locator('[data-slot="devices-table"] [data-slot="device-link"]').first().click()
    const panel = page.locator('[data-slot="device-detail"]')
    await panel.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(toastTitle(page, 'Could not approve the device')).toBeVisible()
  })

  test('a failed pin in the devices list shows an error', async ({ page }) => {
    await page.goto('/devices?mock-fail=putPreferences')
    const star = page
      .locator('tbody tr[data-device-id]')
      .first()
      .getByRole('button', {
        name: /^(Pin|Unpin) /,
      })
    await star.click()
    await expect(toastTitle(page, 'Could not save your preferences')).toBeVisible()
  })

  test('a failed quick connect shows an error', async ({ page }) => {
    await page.goto('/?mock-fail=connectDevice')
    // Quick connect is on the Homelab layout, not the default one.
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await drawer.getByRole('button', { name: 'Homelab' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
    await expect(drawer).toBeHidden()
    const module = page.locator('[data-module-id="quick-connect"]')
    await module
      .getByRole('button', { name: /^Connect to / })
      .first()
      .click()
    await expect(toastTitle(page, 'Could not connect')).toBeVisible()
  })

  test('a failed layout save keeps the edits and says so', async ({ page }) => {
    await page.goto('/?mock-fail=putPreferences')
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await drawer.getByRole('button', { name: 'Homelab' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
    await expect(toastTitle(page, 'Could not save your preferences')).toBeVisible()
    // Still editing, with the change still staged.
    await expect(drawer).toBeVisible()
    await expect(page.locator('[data-module-id="quick-connect"]')).toBeVisible()
  })
})

// A failed GET is retried twice (1 s, then 2 s) before it counts as failed.
const RETRIED = 15_000

test.describe('a module whose data failed says so', () => {
  test.use({ allowConsoleErrors: [/status of 500/i] })

  test('needs attention does not claim "all systems normal" when its data failed', async ({
    page,
  }) => {
    await page.goto('/?mock-fail=statsSummary')
    const module = page.locator('[data-module-id="needs-attention"]')
    await expect(module.locator('[data-slot="module-error-state"]')).toBeVisible({
      timeout: RETRIED,
    })
    await expect(module.getByText(/All systems normal/)).toHaveCount(0)
    await expect(module.getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  test('the dashboard says so when its module catalog failed, instead of loading forever', async ({
    page,
  }) => {
    await page.goto('/?mock-fail=dashboardCatalog')
    await expect(page.locator('[data-slot="error-state"]')).toBeVisible({ timeout: RETRIED })
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  test('the device panel says so when its sessions failed', async ({ page }) => {
    await page.goto('/devices?mock-fail=listSessions')
    await page.locator('[data-slot="devices-table"] [data-slot="device-link"]').first().click()
    const panel = page.locator('[data-slot="device-detail"]')
    await expect(panel.getByText(/^Could not load the sessions/)).toBeVisible({ timeout: RETRIED })
    await expect(panel.getByText('No remote sessions recorded for this device.')).toHaveCount(0)
  })

  // A failed background refetch keeps the data already shown (TanStack keeps
  // it, with isError set): only a failed first load is an error state.
  test('a failed refetch keeps what the modules already show', async ({ page }) => {
    await page.goto('/')
    const needsAttention = page.locator('[data-module-id="needs-attention"]')
    await expect(
      needsAttention.locator('[data-slot="module-empty-state"], li, a').first(),
    ).toBeVisible()
    let failures = 0
    page.on('response', (res) => {
      if (res.url().includes('/stats/summary') && res.status() === 500) failures++
    })
    await mockReady(page)
    await page.evaluate(() => {
      window.__ferricadeMock!.failOperation('statsSummary')
      // Its live events make the page refetch the summary, which now fails.
      window.__ferricadeMock!.approvePendingDevice()
    })
    // The first try and both retries.
    await expect.poll(() => failures, { timeout: 15_000 }).toBeGreaterThanOrEqual(3)
    await expect(page.locator('[data-slot="module-error-state"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="error-state"]')).toHaveCount(0)
  })

  test('live sessions shows an error, not "no active sessions"', async ({ page }) => {
    await page.goto('/?mock-fail=listSessions')
    const module = page.locator('[data-module-id="live-sessions"]')
    await expect(module.locator('[data-slot="module-error-state"]')).toBeVisible({
      timeout: RETRIED,
    })
    await expect(module.getByText('No active sessions')).toHaveCount(0)
  })
})
