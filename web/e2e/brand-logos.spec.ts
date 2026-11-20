import { AUTH_ME_401, expect, test } from './support/test'

const LIGHT_RUST_RGB = 'rgb(183, 65, 14)' // #B7410E
const DARK_RUST_RGB = 'rgb(214, 92, 38)' // #D65C26

test.describe('Ferricade brand logos', () => {
  test.use({ allowConsoleErrors: [AUTH_ME_401] })

  test('sidebar shows flat Wordmark when open/pinned and flat FMark when collapsed', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/devices')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

    const header = page.locator('[data-slot="sidebar-header"]')
    const wordmark = header.locator('[data-brand-logo="wordmark"]')
    const fMark = header.locator('[data-brand-logo="f-mark"]')

    await expect(wordmark).toBeVisible()
    await expect(wordmark).toHaveAttribute('data-brand-variant', 'flat')
    await expect(wordmark).toHaveRole('img')
    await expect(wordmark).toHaveAccessibleName('Ferricade')
    await expect(fMark).toHaveCount(0)

    await page.getByRole('button', { name: 'Unpin sidebar' }).click()
    await page.mouse.move(500, 500)
    await page.evaluate(() => (document.activeElement as HTMLElement).blur())
    await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeHidden()

    await expect(fMark).toBeVisible()
    await expect(fMark).toHaveAttribute('data-brand-variant', 'flat')
    await expect(fMark).toHaveRole('img')
    await expect(fMark).toHaveAccessibleName('Ferricade')
    await expect(wordmark).toHaveCount(0)

    await page.mouse.move(20, 120)
    await expect(wordmark).toBeVisible()
    await expect(fMark).toHaveCount(0)
  })

  test('rust tip keeps brand rust (#B7410E light, #D65C26 dark) in both Ferricade and Ocean palettes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/account/appearance')
    await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible()

    const headerWordmark = page.locator('[data-slot="sidebar-header"] [data-brand-logo="wordmark"]')
    const rustTip = headerWordmark.locator('[data-brand-part="rust"]').first()

    for (const palette of ['Ferricade', 'Ocean'] as const) {
      await page.getByRole('radio', { name: palette }).locator('xpath=..').click()
      await page.getByRole('radio', { name: 'Light' }).click()
      await expect
        .poll(() => rustTip.evaluate((el) => getComputedStyle(el).fill))
        .toBe(LIGHT_RUST_RGB)

      await page.getByRole('radio', { name: 'Dark' }).click()
      await expect
        .poll(() => rustTip.evaluate((el) => getComputedStyle(el).fill))
        .toBe(DARK_RUST_RGB)
    }

    // MiniScreen previews show each palette's own ink (Ocean, Moss, Ferricade all distinct) while keeping brand rust.
    const previewInk = (name: string) =>
      page
        .getByRole('radio', { name })
        .locator('xpath=..')
        .locator('[data-brand-logo="wordmark"] [data-brand-part="ink"]')
        .first()
        .evaluate((el) => getComputedStyle(el).fill)

    const ferricadeInk = await previewInk('Ferricade')
    const oceanInk = await previewInk('Ocean')
    const mossInk = await previewInk('Moss')
    expect(new Set([ferricadeInk, oceanInk, mossInk]).size).toBe(3)

    const oceanPreview = page
      .getByRole('radio', { name: 'Ocean' })
      .locator('xpath=..')
      .locator('[data-brand-logo="wordmark"]')
    await expect
      .poll(() =>
        oceanPreview
          .locator('[data-brand-part="rust"]')
          .first()
          .evaluate((el) => getComputedStyle(el).fill),
      )
      .toBe(DARK_RUST_RGB)

    // Sidebar logo ink also switches hue between Ferricade, Ocean, and Moss.
    const sidebarInk = headerWordmark.locator('[data-brand-part="ink"]').first()
    await page.getByRole('radio', { name: 'Ferricade' }).locator('xpath=..').click()
    const navFerricadeInk = await sidebarInk.evaluate((el) => getComputedStyle(el).fill)
    await page.getByRole('radio', { name: 'Ocean' }).locator('xpath=..').click()
    await expect
      .poll(() => sidebarInk.evaluate((el) => getComputedStyle(el).fill))
      .not.toBe(navFerricadeInk)
    const navOceanInk = await sidebarInk.evaluate((el) => getComputedStyle(el).fill)
    await page.getByRole('radio', { name: 'Moss' }).locator('xpath=..').click()
    await expect
      .poll(() => sidebarInk.evaluate((el) => getComputedStyle(el).fill))
      .not.toBe(navOceanInk)
    const navMossInk = await sidebarInk.evaluate((el) => getComputedStyle(el).fill)
    expect(new Set([navFerricadeInk, navOceanInk, navMossInk]).size).toBe(3)
  })

  test('sign-in and About dialog show rust wordmark at >= 360px and switch to flat below 360px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/sign-in?mock-session=signed-out')
    const signInLogo = page.getByRole('img', { name: 'Ferricade' })
    await expect(signInLogo).toBeVisible()
    await expect(signInLogo).toHaveAttribute('data-brand-variant', 'rust')
    await expect(signInLogo.locator('[data-brand-part="rust-detail"]')).toBeVisible()
    await expect(signInLogo.locator('[data-brand-part="rust-fallback"]')).toBeHidden()

    await page.setViewportSize({ width: 320, height: 640 })
    await expect(signInLogo.locator('[data-brand-part="rust-detail"]')).toBeHidden()
    await expect(signInLogo.locator('[data-brand-part="rust-fallback"]')).toBeVisible()

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await page.getByRole('button', { name: 'About', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'About Ferricade' })
    const aboutLogo = dialog.locator('[data-brand-logo="wordmark"]')
    await expect(aboutLogo).toBeVisible()
    await expect(aboutLogo).toHaveAttribute('data-brand-variant', 'rust')
    await expect(aboutLogo).toHaveAttribute('aria-hidden', 'true')
  })
})
