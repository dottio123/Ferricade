import { expect, test } from './support/test'

test('dashboard approval queue reject can be undone', async ({ page }) => {
  await page.goto('/')
  const queue = page.locator('[data-module-id="approval-queue"]')
  const reject = queue.getByRole('button', { name: /^Reject / }).first()
  await expect(reject).toBeVisible()
  const item = reject.locator('xpath=ancestor::*[@data-slot="queue-item"]')
  const id = await item.getAttribute('data-device-id')
  expect(id).toBeTruthy()
  const rejectedItem = queue.locator(`[data-slot="queue-item"][data-device-id="${id}"]`)
  await rejectedItem.getByRole('button', { name: /^Reject / }).click()
  await expect(page.locator('[data-slot="toast-title"]')).toHaveText('Device rejected')
  await expect(rejectedItem).toHaveCount(0)
  await page.locator('[data-slot="toast-action"]').click()
  await expect(rejectedItem).toBeVisible()
})

test('/devices/queue single reject can be undone', async ({ page }) => {
  await page.goto('/devices/queue')
  const cards = page.locator('main .grid > [data-slot="card"][data-device-id]')
  await expect(cards.first()).toBeVisible()
  const singleId = await cards.first().getAttribute('data-device-id')
  expect(singleId).toBeTruthy()
  const singleCard = page.locator(`main .grid > [data-slot="card"][data-device-id="${singleId}"]`)
  await singleCard.getByRole('button', { name: 'Reject' }).click()
  await expect(page.locator('[data-slot="toast-title"]')).toHaveText('Device rejected')
  await expect(singleCard).toHaveCount(0)
  await page.locator('[data-slot="toast-action"]').click()
  await expect(singleCard).toBeVisible()
})

test('/devices/queue bulk reject can be undone', async ({ page }) => {
  await page.goto('/devices/queue')
  const cards = page.locator('main .grid > [data-slot="card"][data-device-id]')
  await expect(cards.first()).toBeVisible()
  const toolbar = page.locator('[data-slot="queue-bulk-toolbar"]')
  const bulkIds = await cards.evaluateAll((items) =>
    items.map((item) => item.getAttribute('data-device-id')),
  )
  expect(bulkIds.length).toBeGreaterThan(0)
  expect(bulkIds.every(Boolean)).toBe(true)
  await toolbar.getByRole('checkbox', { name: 'Select all visible devices' }).click()
  const rejectMany = toolbar.getByRole('button', { name: /^Reject \(/ })
  await rejectMany.click()
  await expect(page.locator('[data-slot="toast-title"]')).toHaveText(/\d+ devices rejected/)
  await expect(page.getByText('No devices are waiting for approval.')).toBeVisible()
  await page.locator('[data-slot="toast-action"]').click()
  for (const id of bulkIds) {
    await expect(
      page.locator(`main .grid > [data-slot="card"][data-device-id="${id}"]`),
    ).toBeVisible()
  }
})

test('device panel reject can be undone', async ({ page }) => {
  await page.goto('/devices?state=pending')
  const row = page.locator('[data-slot="devices-table"] tbody tr[data-device-id]').first()
  const id = await row.getAttribute('data-device-id')
  expect(id).toBeTruthy()
  await row.locator('a').click()
  const panel = page.locator('[data-slot="device-detail"]')
  await expect(panel).toBeVisible()
  await expect(panel).toHaveAttribute('data-device-id', id!)
  await panel.getByRole('button', { name: 'Reject' }).click()
  await expect(page.locator('[data-slot="toast-title"]')).toHaveText('Device rejected')
  await expect(panel.locator('[data-slot="badge"]').filter({ hasText: /^rejected$/ })).toBeVisible()
  await page.locator('[data-slot="toast-action"]').click()
  await expect(panel.locator('[data-slot="badge"]').filter({ hasText: /^pending$/ })).toBeVisible()
})
