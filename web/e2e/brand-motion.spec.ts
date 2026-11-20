import { AUTH_ME_401, expect, test } from './support/test'

test.describe('Ferricade brand motion (intro & loader)', () => {
  test.use({ allowConsoleErrors: [AUTH_ME_401] })

  test('plays intro once after sign-in, then shows dashboard; reload skips intro', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/sign-in?mock-session=optional')
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()

    await page.getByLabel('Username').fill('alex')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Sign in' }).click()

    const intro = page.locator('[data-slot="brand-intro"]')
    await expect(intro).toBeVisible()
    await expect(intro.getByRole('img', { name: 'Ferricade' })).toBeVisible()

    // Intro settles and exits on its own (~5.1s), leaving the dashboard visible.
    await expect(intro).toHaveCount(0, { timeout: 10_000 })
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Reloading must not replay the intro.
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await expect(intro).toHaveCount(0)
  })

  test('click or key skips intro and leaves focus where it would be without intro', async ({
    page,
  }) => {
    await page.goto('/sign-in?mock-session=optional')
    await page.getByLabel('Username').fill('alex')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Sign in' }).click()

    const intro = page.locator('[data-slot="brand-intro"]')
    await expect(intro).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(intro).toHaveCount(0)

    const activeTag = await page.evaluate(() => document.activeElement?.tagName)
    expect(activeTag).toBe('BODY')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  })

  test('loader ink differs between Ferricade and Ocean while rust stays identical', async ({
    page,
  }) => {
    const readLoaderColors = async (palette: 'ferricade' | 'ocean', mode: 'light' | 'dark') => {
      await page.addInitScript(
        ({ p, m }) => {
          localStorage.setItem(
            'ferricade-appearance',
            JSON.stringify({ palette: p, theme: m, density: 'comfortable' }),
          )
        },
        { p: palette, m: mode },
      )

      await page.goto('/?mock-delay=3000', { waitUntil: 'domcontentloaded' })
      const status = page.getByRole('status', { name: 'Loading' })
      await expect(status).toBeVisible()

      const colors = await status.evaluate((el) => {
        const ink = el.querySelector('.fx-ink')
        const rim = el.querySelector('.r-rim')
        const face = el.querySelector('.r-face')
        return {
          ink: ink ? getComputedStyle(ink).fill : '',
          rim: rim ? getComputedStyle(rim).fill : '',
          face: face ? getComputedStyle(face).fill : '',
        }
      })

      return colors
    }

    const ferricadeLight = await readLoaderColors('ferricade', 'light')
    const oceanLight = await readLoaderColors('ocean', 'light')
    expect(ferricadeLight.ink).not.toBe(oceanLight.ink)
    expect(ferricadeLight.rim).toBe(oceanLight.rim)
    expect(ferricadeLight.face).toBe(oceanLight.face)
    expect(ferricadeLight.rim).toBe('rgb(86, 32, 11)') // #56200B

    const ferricadeDark = await readLoaderColors('ferricade', 'dark')
    const oceanDark = await readLoaderColors('ocean', 'dark')
    expect(ferricadeDark.ink).not.toBe(oceanDark.ink)
    expect(ferricadeDark.rim).toBe(oceanDark.rim)
    expect(ferricadeDark.face).toBe(oceanDark.face)
    expect(ferricadeDark.rim).toBe('rgb(132, 50, 16)') // #843210
  })

  test('prefers-reduced-motion drops rings and uses static fade on intro', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/sign-in?mock-session=optional')
    await page.getByLabel('Username').fill('alex')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Sign in' }).click()

    const intro = page.locator('[data-slot="brand-intro"]')
    await intro.waitFor({ state: 'visible' })
    const styles = await intro.evaluate((root) => {
      const ring = root.querySelector('.fx-ring')
      const fGroup = root.querySelector('.fi-f')
      return {
        isConnected: root.isConnected,
        ringDisplay: ring ? getComputedStyle(ring).display : null,
        animName: fGroup ? getComputedStyle(fGroup).animationName : null,
        animDuration: fGroup ? getComputedStyle(fGroup).animationDuration : null,
      }
    })
    expect(styles.isConnected).toBe(true)
    expect(styles.ringDisplay).toBe('none')
    expect(styles.animName).toBe('fx-in')
    expect(styles.animDuration).toBe('0.6s')

    await expect(intro).toHaveCount(0, { timeout: 5_000 })
  })
})
