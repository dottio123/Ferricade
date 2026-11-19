// Rulings F1 and F5: Radix (behind Dialog, DropdownMenu, Sheet, Select, Popover, Tooltip,
// Toast and Command Dialog) adds <style> elements at runtime (react-remove-scroll-bar's
// scroll lock, through react-style-singleton, and Select's scrollbar-hide). ferricade's CSP allows
// a <style> only with the nonce of the index.html response (style-src 'self' 'nonce-…'), which
// main.tsx hands to get-nonce and Select passes via cspNonce(). This opens all overlays on
// the kitchen sink under that CSP, with the console guard on, and checks the scroll lock
// applies where modal. Never work around a failure here with 'unsafe-inline' or modal={false}.
import type { Page } from '@playwright/test'
import { expect, recordViolations, test } from './support/test'

/** The body's computed overflow and whether the scroll lock marked it. */
function bodyLock(page: Page) {
  return page.evaluate(() => ({
    overflow: getComputedStyle(document.body).overflow,
    locked: document.body.hasAttribute('data-scroll-locked'),
  }))
}

test('all overlays open under the CSP with no violation and correct scroll locks', async ({
  page,
}) => {
  const violations = await recordViolations(page)
  await page.goto('/dev/kitchen-sink')
  await expect(page.getByRole('heading', { level: 1, name: 'Kitchen sink' })).toBeVisible()
  expect(await bodyLock(page)).toEqual({ overflow: 'visible', locked: false })

  // 1. Dialog
  await page.getByRole('button', { name: 'Open dialog' }).click()
  const dialog = page.getByRole('dialog', { name: 'Approve 3 devices' })
  await expect(dialog).toBeVisible()
  expect(await bodyLock(page)).toEqual({ overflow: 'hidden', locked: true })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // 2. Dropdown Menu
  await page.getByRole('button', { name: 'Open menu' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Approve' })).toBeVisible()
  expect(await bodyLock(page)).toEqual({ overflow: 'hidden', locked: true })
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  // 3. Sheet
  await page.getByRole('button', { name: 'Open sheet' }).click()
  const sheet = page.getByRole('dialog', { name: 'Device details' })
  await expect(sheet).toBeVisible()
  expect(await bodyLock(page)).toEqual({ overflow: 'hidden', locked: true })
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()

  // 4. Select
  await page.getByRole('combobox').click()
  const selectList = page.getByRole('listbox')
  await expect(selectList).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(selectList).toBeHidden()

  // 5. Popover
  await page.getByRole('button', { name: 'Open popover' }).click()
  await expect(page.getByText('Quick Connect URL')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('Quick Connect URL')).toBeHidden()

  // 6. Tooltip
  await page.getByRole('button', { name: 'Hover or focus tooltip' }).hover()
  await expect(page.getByText('Accessible tooltip payload')).toBeVisible()

  // 7. Toast
  await page.getByRole('button', { name: 'Trigger toast' }).click()
  await expect(page.locator('[data-slot="toast-title"]').getByText('Device approved')).toBeVisible()
  await expect(
    page
      .locator('[data-slot="toast-description"]')
      .getByText('lab-node-03 has been admitted to the fleet.'),
  ).toBeVisible()

  // 8. Command Dialog
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const commandInput = page.getByPlaceholder('Type a command or search devices...')
  await expect(commandInput).toBeVisible()
  expect(await bodyLock(page)).toEqual({ overflow: 'hidden', locked: true })
  await page.keyboard.press('Escape')
  await expect(commandInput).toBeHidden()

  // Zero CSP violations recorded
  expect(await violations()).toEqual([])
})
