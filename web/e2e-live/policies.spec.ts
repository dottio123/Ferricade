// Runs after flow.spec.ts creates the owner and approves rdsim's first device.
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { startRdsim } from './support/stack'
import { totp } from './support/totp'

const DEVICE = 'sim-100000000'
const STEP_MS = 30_000
const HEARTBEAT_TIMEOUT = 45_000 // rdsim runs with -interval 2s.

async function signInOwner(page: Page): Promise<void> {
  const owner = JSON.parse(readFileSync('test-results-live/owner.json', 'utf8')) as {
    username: string
    password: string
    totpSecret: string
    lastStep: number
  }
  const wait = (owner.lastStep + 1) * STEP_MS - Date.now()
  if (wait > 0) await page.waitForTimeout(wait)
  await page.goto('/sign-in')
  await page.getByLabel('Username').fill(owner.username)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Two-factor code' })).toBeVisible()
  const signInAt = Date.now() + STEP_MS
  owner.lastStep = Math.floor(signInAt / STEP_MS)
  await page.getByLabel('Code').fill(totp(owner.totpSecret, signInAt))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
  writeFileSync('test-results-live/owner.json', JSON.stringify(owner))
}

test('an owner pushes client policies and manages an access window', async ({ page }) => {
  test.setTimeout(180_000)
  await signInOwner(page)
  const stopRdsim = startRdsim(['-devices', '1', '-interval', '2s'], '5m')
  try {
    await test.step('set Default baseline to Click and enable policy push', async () => {
      await page.goto('/policies')
      await page.getByRole('button', { name: 'Edit Default' }).click()
      await page.getByLabel('How incoming connections are accepted').click()
      await page.getByRole('option', { name: 'Click to accept only' }).click()
      await page.getByRole('button', { name: 'Save changes' }).click()
      await expect(page.getByRole('heading', { name: 'Confirm access baseline' })).toBeVisible()
      await page.getByRole('button', { name: 'Save anyway' }).click()
      await expect(page.getByRole('button', { name: 'Edit Default' })).toBeVisible()

      const push = page.getByRole('switch', { name: 'Policy push' })
      await push.click()
      await page.getByRole('button', { name: 'Turn on', exact: true }).click()
      await expect(push).toBeChecked()
    })

    await page.goto('/devices?state=approved')
    await page.locator('[data-slot="devices-table"]').getByRole('link', { name: DEVICE }).click()
    const panel = page.locator('[data-slot="device-detail"]')
    const statusLine = panel.locator('[data-slot="policy-status-line"]')
    await expect(panel).toBeVisible()
    await test.step('confirm baseline and window strategies', async () => {
      await expect(statusLine).toContainText('· Applied', { timeout: HEARTBEAT_TIMEOUT })
      await panel.getByRole('button', { name: 'Allow access' }).click()
      await panel.getByLabel('Duration').selectOption('60')
      await panel.getByRole('button', { name: 'Open window' }).click()
      await expect(panel.locator('[data-slot="access-window-status"]')).toContainText(
        'Reachable until',
      )
      await expect(statusLine).toContainText('· Applied', { timeout: HEARTBEAT_TIMEOUT })
    })

    await test.step('close and confirm the baseline strategy', async () => {
      await panel.getByRole('button', { name: 'Close now' }).click()
      await expect(panel.getByText(/Closing… not confirmed by the device/)).toBeVisible()
      await expect(panel.locator('[data-slot="unconfirmed-close-warning"]')).toHaveCount(0, {
        timeout: HEARTBEAT_TIMEOUT,
      })
      await expect(statusLine).toContainText('· Applied', { timeout: HEARTBEAT_TIMEOUT })
    })

    await test.step('refuse push off with an open window, then switch it off after close', async () => {
      await panel.getByRole('button', { name: 'Allow access' }).click()
      await panel.getByLabel('Duration').selectOption('60')
      await panel.getByRole('button', { name: 'Open window' }).click()
      await expect(panel.locator('[data-slot="access-window-status"]')).toContainText(
        'Reachable until',
      )

      await page.goto('/policies')
      const push = page.getByRole('switch', { name: 'Policy push' })
      await push.click()
      await page.getByRole('button', { name: 'Turn off', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('close the open access windows first')
      await expect(push).toBeChecked()

      await page.goto('/devices?state=approved')
      await page.locator('[data-slot="devices-table"]').getByRole('link', { name: DEVICE }).click()
      const devicePanel = page.locator('[data-slot="device-detail"]')
      await devicePanel.getByRole('button', { name: 'Close now' }).click()
      await expect(devicePanel.locator('[data-slot="unconfirmed-close-warning"]')).toHaveCount(0, {
        timeout: HEARTBEAT_TIMEOUT,
      })

      await page.goto('/policies')
      const pushAfterClose = page.getByRole('switch', { name: 'Policy push' })
      await pushAfterClose.click()
      await page.getByRole('button', { name: 'Turn off', exact: true }).click()
      await expect(pushAfterClose).not.toBeChecked()
    })
  } finally {
    stopRdsim()
  }
})
