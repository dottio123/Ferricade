import { expect, test } from './support/test'

async function openWithKeyboard(opener: import('@playwright/test').Locator) {
  await opener.focus()
  await opener.press('Enter')
}

test('group and tag dialogs restore their keyboard openers', async ({ page }) => {
  await page.goto('/groups')
  const groupButton = page.getByRole('button', { name: 'New group' })
  await openWithKeyboard(groupButton)
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(groupButton).toBeFocused()

  await page.goto('/tags')
  const tagButton = page.getByRole('button', { name: 'New tag' })
  await openWithKeyboard(tagButton)
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tagButton).toBeFocused()
})

test('palette and Customize drawer restore their keyboard openers', async ({ page }) => {
  await page.goto('/')
  const search = page.locator('header').getByRole('button', { name: /Search \(/ })
  await openWithKeyboard(search)
  await expect(page.locator('[data-slot="command-dialog"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(search).toBeFocused()

  const customize = page.getByRole('button', { name: 'Customize' })
  await openWithKeyboard(customize)
  await expect(page.locator('[data-slot="sheet-content"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Modules & Presets' })).toBeFocused()
})

test('device panel restores its keyboard opener', async ({ page }) => {
  await page.goto('/devices')
  const device = page.locator('[data-slot="devices-table"] tbody tr a').first()
  await expect(device).toBeVisible()
  await openWithKeyboard(device)
  await expect(page.locator('[data-slot="device-detail"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(device).toBeFocused()
})

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('focuses the current link and restores the menu button', async ({ page }) => {
    await page.goto('/devices')
    const menu = page.getByRole('button', { name: 'Open navigation menu' })
    await openWithKeyboard(menu)
    const nav = page.getByRole('navigation', { name: 'Mobile navigation' })
    await expect(nav).toBeVisible()
    await expect(nav.getByRole('link', { name: /Devices/ })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toBeFocused()
  })
})

test('confirm dialogs restore their keyboard openers', async ({ page }) => {
  await page.goto('/devices/queue')
  const approveAll = page.getByRole('button', { name: /^Approve all/ })
  await expect(approveAll).toBeVisible()
  await openWithKeyboard(approveAll)
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(approveAll).toBeFocused()

  await page.goto('/devices?state=approved')
  const link = page.locator('tbody tr[data-device-id] [data-slot="device-link"]').first()
  await expect(link).toBeVisible()
  await link.click()
  const panel = page.locator('[data-slot="device-detail"]')
  const del = panel.getByRole('button', { name: 'Delete', exact: true })
  await openWithKeyboard(del)
  const confirm = page.locator('[data-slot="device-delete-dialog"]')
  await expect(confirm).toBeVisible()
  // Escape goes to the topmost Radix layer only once focus is inside it.
  await expect(confirm.locator(':focus')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(panel).toBeVisible()
  await expect(del).toBeFocused()
})
