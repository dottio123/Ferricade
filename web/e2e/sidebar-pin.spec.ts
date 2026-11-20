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

test('unpinned hover shows bottom items visible and clickable', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('ferricade.sidebar.pinned') === null) {
      localStorage.setItem('ferricade.sidebar.pinned', 'false')
    }
  })
  await page.mouse.move(500, 500)
  await page.goto('/devices')
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

  await page.mouse.move(20, 120)
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeVisible()

  const about = page.locator('aside').getByRole('button', { name: 'About' })
  const settings = page.locator('aside').getByRole('link', { name: 'System Settings' })
  const profile = page.locator('aside').getByRole('button', { name: /Profile:/ })

  for (const locator of [about, settings, profile]) {
    await expect(locator).toBeVisible()
    await expect.poll(async () => (await locator.boundingBox())?.width ?? 0).toBeGreaterThan(150)
    const hitsTarget = await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit === el || el.contains(hit)
    })
    expect(hitsTarget).toBe(true)
  }

  await about.click()
  const dialog = page.getByRole('dialog', { name: 'About Ferricade' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await page.mouse.move(20, 120)
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeVisible()
  await settings.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
})

test('pointer leave closes after unpin and nav click, while nav click keeps hovered sidebar open', async ({
  page,
}) => {
  await page.mouse.move(500, 500)
  await page.goto('/devices')
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

  // Click Unpin with pointer: stays open while hovered, closes on pointer leave even with focus inside
  await page.getByRole('button', { name: 'Unpin sidebar' }).click()
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeVisible()
  await page.mouse.move(500, 500)
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeHidden({ timeout: 1000 })

  // Hover to expand, click a nav link: stays open while hovered, then closes on pointer leave
  await page.mouse.move(20, 120)
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeVisible()
  await page
    .locator('aside')
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Sessions' })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()
  await page.waitForTimeout(450)
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeVisible()

  await page.mouse.move(500, 500)
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeHidden({ timeout: 1000 })
})

test('keyboard Tab opens unpinned sidebar, Escape closes keeping focus, blur closes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('ferricade.sidebar.pinned', 'false')
  })
  await page.mouse.move(500, 500)
  await page.goto('/devices')
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeHidden()

  const skipLink = page.getByRole('link', { name: 'Skip to content' })
  await skipLink.focus()
  await page.keyboard.press('Tab')

  const firstNavLink = page.locator('aside nav a').first()
  await expect(firstNavLink).toBeFocused()
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeHidden()
  await expect(firstNavLink).toBeFocused()

  await page.keyboard.press('Tab')
  await expect(page.locator('aside nav a').nth(1)).toBeFocused()
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeVisible()

  await page.locator('#main-content').focus()
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeHidden({ timeout: 1000 })
})

test('reduced motion still opens and closes unpinned sidebar without width slide', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    localStorage.setItem('ferricade.sidebar.pinned', 'false')
  })
  await page.mouse.move(500, 500)
  await page.goto('/devices')
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

  const panel = page.locator('[data-slot="sidebar-panel"]')
  const reducedTransition = await panel.evaluate((el) => getComputedStyle(el).transitionProperty)
  expect(reducedTransition).toBe('none')

  await page.mouse.move(20, 120)
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeVisible()
  expect((await panel.boundingBox())?.width).toBe(240)
  await page.mouse.move(500, 500)
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeHidden({ timeout: 1000 })
  expect((await panel.boundingBox())?.width).toBe(64)
})
