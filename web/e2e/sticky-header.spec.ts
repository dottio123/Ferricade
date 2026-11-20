import { expect, test } from './support/test'

async function scrollToBottom(page: import('@playwright/test').Page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
}

test('mobile top bar stays reachable after scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/devices?mock=large')
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
  const loadMoreButton = page.getByRole('button', { name: 'Load more' })
  await expect(loadMoreButton).toBeVisible()
  await loadMoreButton.click()
  await loadMoreButton.click()
  await scrollToBottom(page)

  for (const button of [
    page.getByRole('button', { name: 'Open navigation menu' }),
    page.getByRole('button', { name: /^Search/ }),
  ]) {
    const box = await button.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(844)
  }

  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible()
})

test('desktop search stays reachable after scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.goto('/devices')
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
  await scrollToBottom(page)

  const box = await page.getByRole('button', { name: /^Search/ }).boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(600)
})

test('bulk action bar sticks below the top bar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.goto('/devices')
  const checkbox = page
    .locator('[data-slot="devices-table"] tbody tr input[type="checkbox"]')
    .first()
  await expect(checkbox).toBeVisible()
  await checkbox.click()

  const bulkBar = page.locator('[data-slot="bulk-action-bar"]')
  await expect(bulkBar).toBeVisible()
  await scrollToBottom(page)

  const [headerBox, bulkBox] = await Promise.all([
    page.locator('header').boundingBox(),
    bulkBar.boundingBox(),
  ])
  expect(headerBox).not.toBeNull()
  expect(bulkBox).not.toBeNull()
  expect(bulkBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1)
})
