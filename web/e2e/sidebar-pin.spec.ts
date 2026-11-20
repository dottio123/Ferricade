import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from './support/test'

test('auto sidebar expands over content, collapses on leave, and remembers pinning', async ({
  page,
}) => {
  await page.mouse.move(500, 500)
  await page.addInitScript(() => {
    if (localStorage.getItem('ferricade.sidebar.pinned') === null) {
      localStorage.setItem('ferricade.sidebar.pinned', 'false')
    }
  })
  await page.goto('/devices')
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
  const main = page.locator('#main-content')
  const before = await main.boundingBox()
  const sidebar = page.locator('aside')
  await page.mouse.move(20, 120)
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeVisible({ timeout: 1000 })
  const during = await main.boundingBox()
  expect(during?.x).toBe(before?.x)
  expect(during?.width).toBe(before?.width)
  await page.mouse.move(500, 500)
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeHidden()
  await sidebar
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Devices' })
    .hover()
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeVisible()
  await page.getByRole('button', { name: 'Pin sidebar' }).click()
  await expect(page.getByRole('button', { name: 'Unpin sidebar' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.reload()
  await expect(page.getByRole('button', { name: 'Unpin sidebar' })).toBeVisible()
})

test('captures sidebar modes in light and dark themes', async ({ page }) => {
  const directory = resolve(process.cwd(), '../docs/orchestration/reports/t275')
  await mkdir(directory, { recursive: true })
  await page.mouse.move(500, 500)
  for (const theme of ['light', 'dark'] as const) {
    await page.goto('/devices')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
    await expect(page.getByText('ubuntu-nuc', { exact: true })).toBeVisible()
    await page.evaluate((mode) => document.documentElement.setAttribute('data-theme', mode), theme)
    await page.screenshot({ path: resolve(directory, `sidebar-pinned-${theme}.png`) })

    await page.evaluate(() => localStorage.setItem('ferricade.sidebar.pinned', 'false'))
    await page.reload()
    await page.mouse.move(500, 500)
    await expect(page.getByText('ubuntu-nuc', { exact: true })).toBeVisible()
    await page.evaluate((mode) => document.documentElement.setAttribute('data-theme', mode), theme)
    await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeHidden()
    await page.screenshot({ path: resolve(directory, `sidebar-collapsed-${theme}.png`) })

    await page.mouse.move(20, 120)
    await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeVisible()
    await page.screenshot({ path: resolve(directory, `sidebar-expanded-${theme}.png`) })
    await page.evaluate(() => localStorage.setItem('ferricade.sidebar.pinned', 'true'))
    await page.mouse.move(500, 500)
  }
})
