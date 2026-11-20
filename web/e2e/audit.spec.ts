import { expect, test } from './support/test'

test.describe('Audit Log page', () => {
  test('loads Audit Log page with heading, filters, and timeline entries', async ({ page }) => {
    await page.goto('/audit')
    await expect(page.getByRole('heading', { level: 1, name: 'Audit Log' })).toBeVisible()

    // Filter bar
    const filterBar = page.locator('[data-slot="audit-filter-bar"]')
    await expect(filterBar).toBeVisible()

    // Audit timeline and items
    const timeline = page.locator('[data-slot="audit-timeline"]')
    await expect(timeline).toBeVisible()

    const items = page.locator('[data-slot="audit-event-item"]')
    await expect(items.first()).toBeVisible()
    expect(await items.count()).toBeGreaterThan(0)
  })

  test('filters by action and resets', async ({ page }) => {
    await page.goto('/audit')
    const filterBar = page.locator('[data-slot="audit-filter-bar"]')

    // Open Action select
    const actionSelect = filterBar.getByRole('combobox', { name: 'Filter by action' })
    await actionSelect.click()

    // Select Approved device
    await page.getByPlaceholder('Search actions…').fill('approved')
    await page.getByRole('option', { name: 'Approved device' }).click()
    await expect(page).toHaveURL(/action=device\.approved/)

    // Verify all rendered rows have data-action="device.approved"
    const items = page.locator('[data-slot="audit-event-item"]')
    await expect(items.first()).toBeVisible()
    const actions = await items.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-action')),
    )
    for (const a of actions) {
      expect(a).toBe('device.approved')
    }

    // Reset filters
    await filterBar.getByRole('button', { name: 'Reset' }).click()
    await expect(page).toHaveURL('/audit')
  })

  test('filters by target parameter in URL', async ({ page }) => {
    await page.goto('/audit?target=default')
    await expect(page.getByRole('heading', { level: 1, name: 'Audit Log' })).toBeVisible()

    // Target badge visible
    const targetBadge = page.locator('[data-slot="audit-filter-bar"]').getByText(/Target: default/)
    await expect(targetBadge).toBeVisible()

    // Click clear on target badge
    await page.getByLabel('Clear target filter').click()
    await expect(page).toHaveURL('/audit')
  })

  test('filters by time range presets (24h, 7d)', async ({ page }) => {
    await page.goto('/audit')
    const filterBar = page.locator('[data-slot="audit-filter-bar"]')

    // Click 24h
    await filterBar.getByRole('button', { name: '24h' }).click()
    await expect(page).toHaveURL(/range=24h/)
    await expect(page).toHaveURL(/since=/)

    // Click 7d
    await filterBar.getByRole('button', { name: '7d' }).click()
    await expect(page).toHaveURL(/range=7d/)

    // Reset
    await filterBar.getByRole('button', { name: 'Reset' }).click()
    await expect(page).toHaveURL('/audit')
  })

  test('expands raw JSON details and copies JSON', async ({ page }) => {
    await page.goto('/audit')
    const firstItem = page.locator('[data-slot="audit-event-item"]').first()
    await expect(firstItem).toBeVisible()

    // Click chevron to expand details
    const expandButton = firstItem.getByRole('button', { name: /details/i })
    await expandButton.click()

    // Details <pre> is visible
    const jsonBlock = firstItem.locator('[data-slot="audit-json-details"]')
    await expect(jsonBlock).toBeVisible()

    // Copy JSON button
    const copyButton = firstItem.getByRole('button', { name: /Copy JSON/i })
    await expect(copyButton).toBeVisible()
    await copyButton.click()
    await expect(firstItem.getByText('Copied')).toBeVisible()

    // Click again to collapse
    await expandButton.click()
    await expect(jsonBlock).toBeHidden()
  })

  test('opens the device panel on this page when a device target is clicked', async ({ page }) => {
    // Filter by device.approved to guarantee a device link exists
    await page.goto('/audit?action=device.approved')
    const firstDeviceLink = page
      .locator('[data-slot="audit-event-item"]')
      .first()
      .locator('[data-slot="device-link"]')
    await expect(firstDeviceLink).toBeVisible()

    await firstDeviceLink.click()
    await expect(page).toHaveURL(/\/audit\?.*action=device\.approved/)
    await expect(page).toHaveURL(/[?&]device=/)
    await expect(page.locator('[data-slot="device-detail"]')).toBeVisible()
  })
})
