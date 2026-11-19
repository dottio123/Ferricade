import { expect, test } from './support/test'

test('sorts the device list by name and group, and restores the sort from the URL', async ({
  page,
}) => {
  await page.goto('/devices')
  const table = page.locator('[data-slot="devices-table"]')
  await expect(table.locator('tbody tr').first()).toBeVisible()

  await page.getByRole('button', { name: 'Sort by Device' }).click()
  await page.getByRole('button', { name: 'Sort by Device' }).click()
  await expect(page).toHaveURL(/[?&]sort=name&order=desc/)

  const lastName = await page.evaluate(async () => {
    const response = await fetch('/admin/api/v1/devices?sort=name&order=desc&limit=200')
    const body = (await response.json()) as {
      items: { alias: string; hostname: string; rustdesk_id: string }[]
    }
    const device = body.items[0]!
    return device.alias || device.hostname || device.rustdesk_id
  })
  await expect(table.locator('tbody tr').first()).toContainText(lastName)

  await page.reload()
  await expect(page).toHaveURL(/[?&]sort=name&order=desc/)
  await expect(page.getByRole('columnheader', { name: /Device/ })).toHaveAttribute(
    'aria-sort',
    'descending',
  )

  await page.getByRole('button', { name: 'Sort by Group' }).click()
  await expect(page).toHaveURL(/[?&]sort=group&order=asc/)
  while (await page.getByRole('button', { name: 'Load more' }).count()) {
    await page.getByRole('button', { name: 'Load more' }).click()
  }
  await expect(table.locator('tbody tr').last().locator('td').nth(6)).toHaveText('No group')
})
