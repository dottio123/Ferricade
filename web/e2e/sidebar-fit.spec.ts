import { expect, test } from './support/test'

test.describe('desktop sidebar fits the viewport', () => {
  test('keeps bottom items visible at 1280x800 and 1280x480 without nav scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/devices?mock=large')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.body.scrollHeight)).toBeGreaterThan(800)

    const nav = page.getByRole('navigation', { name: 'Main' })
    const sidebar = page.locator('aside').filter({ has: nav })
    const about = page.getByRole('button', { name: 'About' })
    const settings = page.getByRole('link', { name: 'System Settings' })
    const profile = page.getByRole('button', { name: /Profile:/ })
    let regularLinkHeight = 0

    for (const height of [800, 480]) {
      await page.setViewportSize({ width: 1280, height })
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      expect((await sidebar.boundingBox())?.y).toBe(0)
      for (const item of [about, settings, profile]) {
        const box = await item.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.y).toBeGreaterThanOrEqual(0)
        expect(box!.y + box!.height).toBeLessThanOrEqual(height)
      }
      expect(await nav.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
        true,
      )

      if (height === 800) {
        regularLinkHeight = await nav
          .getByRole('link', { name: 'Devices' })
          .evaluate((element) => element.getBoundingClientRect().height)
      } else {
        const compactLinkHeight = await nav
          .getByRole('link', { name: 'Devices' })
          .evaluate((element) => element.getBoundingClientRect().height)
        expect(compactLinkHeight).toBeLessThan(regularLinkHeight!)
      }
    }
  })

  test('keeps bottom items visible at 1280x360 while the page links may scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 360 })
    await page.goto('/devices?mock=large')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    expect((await page.locator('aside').boundingBox())?.y).toBe(0)

    for (const item of [
      page.getByRole('button', { name: 'About' }),
      page.getByRole('link', { name: 'System Settings' }),
      page.getByRole('button', { name: /Profile:/ }),
    ]) {
      const box = await item.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(360)
    }
  })

  test('keeps bottom items visible with the sidebar collapsed at 1280x480', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 480 })
    await page.goto('/devices?mock=large')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
    await page.getByRole('button', { name: 'Unpin sidebar' }).click()
    await page.mouse.move(500, 500)
    await page.evaluate(() => (document.activeElement as HTMLElement).blur())
    await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeHidden()
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    expect((await page.locator('aside').boundingBox())?.y).toBe(0)

    for (const item of [
      page.getByRole('button', { name: 'About' }),
      page.getByRole('link', { name: 'System Settings' }),
      page.getByRole('button', { name: /Profile:/ }),
    ]) {
      const box = await item.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(480)
    }
  })
})
