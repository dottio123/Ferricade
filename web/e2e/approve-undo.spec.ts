import { expect, test } from './support/test'

test('/devices/queue approve can be undone', async ({ page }) => {
  await page.goto('/devices/queue')
  const cards = page.locator('main .grid > [data-slot="card"][data-device-id]')
  await expect(cards.first()).toBeVisible()
  const id = await cards.first().getAttribute('data-device-id')
  expect(id).toBeTruthy()
  const card = page.locator(`main .grid > [data-slot="card"][data-device-id="${id}"]`)
  await card.getByRole('button', { name: 'Approve' }).click()
  await expect(page.locator('[data-slot="toast-title"]')).toHaveText('Device approved')
  await expect(card.getByRole('status')).toHaveText('Approved')
  await page.locator('[data-slot="toast-action"]').click()
  await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible()
})

test('Approve all confirms names and Cancel approves nothing', async ({ page }) => {
  await page.goto('/devices/queue')
  const cards = page.locator('main .grid > [data-slot="card"][data-device-id]')
  await expect(cards.first()).toBeVisible()
  const id = await cards.first().getAttribute('data-device-id')
  const name = await cards.first().locator('[data-slot="card-title"]').textContent()
  await page.getByRole('button', { name: /^Approve all/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(name!)
  await expect(dialog).toContainText('They can be connected to as soon as they are approved.')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(
    page.locator(`main .grid > [data-slot="card"][data-device-id="${id}"]`),
  ).toBeVisible()
})

test('second click at the same spot does not approve another device', async ({ page }) => {
  await page.goto('/devices/queue')
  const cards = page.locator('main .grid > [data-slot="card"][data-device-id]')
  await expect(cards.nth(1)).toBeVisible()
  const first = await cards.first().getAttribute('data-device-id')
  const second = await cards.nth(1).getAttribute('data-device-id')
  const approve = cards.first().getByRole('button', { name: 'Approve' })
  const box = await approve.boundingBox()
  expect(box).toBeTruthy()
  const x = box!.x + box!.width / 2
  const y = box!.y + box!.height / 2
  await page.mouse.click(x, y)
  await expect(page.locator(`[data-device-id="${first}"]`).getByRole('status')).toHaveText(
    'Approved',
  )
  await page.mouse.click(x, y)
  await expect(
    page.locator(`[data-device-id="${second}"]`).getByRole('button', { name: 'Approve' }),
  ).toBeVisible()
})
