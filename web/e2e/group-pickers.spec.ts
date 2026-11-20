// The three group pickers show the group tree: collapsible in the Assign devices
// dialog, searchable popovers in the device panel and the Devices filter.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test } from './support/test'

test.use({ allowConsoleErrors: [/status of 403 .*\/users/] })

async function severeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  return results.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.html) }))
}

test('picks a subgroup in the device Group picker by search and saves it', async ({ page }) => {
  await page.goto('/devices')
  await page.locator('[data-slot="devices-table"] tbody tr a').first().click()
  const panel = page.locator('[data-slot="device-detail"]')
  await expect(panel).toBeVisible()

  const trigger = panel.locator('#device-group')
  await trigger.click()
  const search = page.getByRole('combobox', { name: 'Search groups' })
  await expect(search).toBeFocused()
  expect(await severeViolations(page)).toEqual([])
  await search.fill('recep')
  const match = page.getByRole('treeitem', { name: 'Office / Reception' })
  await expect(match).toBeVisible()
  await match.click()
  await expect(page.getByRole('tree')).toHaveCount(0)
  await expect(trigger).toHaveText('Office / Reception')

  await panel.getByRole('button', { name: 'Save changes' }).click()
  await expect(
    page.locator('[data-slot="toast-title"]').getByText('Device updated', { exact: true }),
  ).toBeVisible()
  await expect(trigger).toHaveText('Office / Reception')
})

test('the device Group picker works from the keyboard', async ({ page }) => {
  await page.goto('/devices')
  await page.locator('[data-slot="devices-table"] tbody tr a').first().click()
  const panel = page.locator('[data-slot="device-detail"]')
  const trigger = panel.locator('#device-group')
  await trigger.focus()
  await page.keyboard.press('Enter')
  const search = page.getByRole('combobox', { name: 'Search groups' })
  await expect(search).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tree')).toHaveCount(0)
  await expect(panel).toBeVisible()
  await expect(trigger).toBeFocused()
})

test('filters the Devices list by a subgroup', async ({ page }) => {
  await page.goto('/devices')
  await expect(page.locator('[data-slot="devices-table"] tbody tr').first()).toBeVisible()
  await page.getByRole('button', { name: 'Filter by group' }).click()
  await expect(page.getByText('Shows devices in this group only, not its subgroups.')).toBeVisible()
  expect(await severeViolations(page)).toEqual([])
  await page.getByRole('combobox', { name: 'Search groups' }).fill('Engineering')
  await page.getByRole('treeitem', { name: 'Office / Engineering' }).click()
  await expect(page).toHaveURL(/[?&]group=/)
  await expect(page.getByRole('button', { name: 'Filter by group' })).toHaveText(
    'Office / Engineering',
  )
  await expect(page.locator('[data-slot="devices-table"] tbody tr').first()).toBeVisible()
})

test('collapses and expands groups in the Assign devices dialog', async ({ page }) => {
  await page.goto('/settings/users')
  await page.getByRole('table').getByRole('button', { name: 'Assign devices to helpdesk' }).click()
  const dialog = page.getByRole('dialog')
  // helpdesk holds Office, so it starts expanded with its subgroups covered.
  const reception = dialog.getByRole('checkbox', { name: 'Reception', exact: true })
  await expect(reception).toBeVisible()
  await dialog.getByRole('button', { name: 'Collapse Office' }).click()
  await expect(reception).toHaveCount(0)
  await expect(dialog.getByRole('checkbox', { name: 'Office', exact: true })).toBeChecked()
  await dialog.getByRole('button', { name: 'Expand Office' }).click()
  await expect(reception).toBeVisible()
  expect(await severeViolations(page)).toEqual([])
})
