import { expect, test } from './support/test'

test('keeps the group filter aligned when subgroup selection changes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/devices')
  const group = page.getByRole('button', { name: 'Filter by group' })
  const status = page.getByRole('combobox', { name: 'Filter by online status' })
  const top = async () => (await group.boundingBox())!.y
  const initial = await top()
  await group.click()
  await page.getByRole('treeitem', { name: 'Office' }).click()
  expect(await top()).toBe(initial)
  expect(await top()).toBe((await status.boundingBox())!.y)
  await page.getByLabel('Include subgroups').check()
  expect(await top()).toBe(initial)
  await page.getByRole('button', { name: 'Sort by Group' }).click()
  expect(await top()).toBe(initial)
  await page.getByLabel('Include subgroups').uncheck()
  expect(await top()).toBe(initial)
})

test('includes subgroup devices from the group filter and keeps it in the URL', async ({
  page,
}) => {
  await page.goto('/devices')
  await page.getByRole('button', { name: 'Filter by group' }).click()
  await page.getByRole('treeitem', { name: 'Office' }).click()
  await expect(page.getByLabel('Include subgroups')).toBeVisible()
  await expect(page.getByText('No devices match these filters')).toBeVisible()

  await page.getByLabel('Include subgroups').check()
  await expect(page).toHaveURL(/[?&]subgroups=true(?:&|$)/)
  const rows = page.locator('[data-slot="devices-table"] tbody tr')
  await expect(rows.first()).toBeVisible()
  await expect(rows).not.toHaveCount(0)
})
