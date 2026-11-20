import { expect, test } from './support/test'

test.describe('Appearance settings', () => {
  test.use({
    allowConsoleErrors: [
      /status of 500 \(Internal Server Error\) .*\/admin\/api\/v1\/me\/preferences/,
    ],
  })

  test('user settings links to Appearance', async ({ page }) => {
    await page.goto('/account')
    await page.getByRole('link', { name: 'Appearance' }).click()
    await expect(page).toHaveURL(/\/account\/appearance$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible()
  })

  test('persists the palette before first paint and keeps it across a mode change', async ({
    page,
  }) => {
    await page.goto('/account/appearance')
    await page.getByRole('radio', { name: 'Ocean' }).locator('xpath=..').click()
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'ocean')

    await page.goto('/account/appearance?mock-delay=4000', { waitUntil: 'domcontentloaded' })
    // Read once while every mock response is pending; only theme.js can have set this.
    expect(await page.evaluate(() => document.documentElement.dataset.palette)).toBe('ocean')
    await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toHaveCount(0)

    await page.goto('/account/appearance')
    await expect(page.getByRole('radio', { name: 'Ocean' })).toBeChecked()

    await page.getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'ocean')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await page.getByRole('radio', { name: 'Indigo' }).locator('xpath=..').click()
    await expect(page.locator('html')).not.toHaveAttribute('data-palette')
  })

  test('restores the prior palette and reports a failed save', async ({ page }) => {
    await page.goto('/account/appearance?mock-fail=putPreferences')
    await page.getByRole('radio', { name: 'Graphite' }).locator('xpath=..').click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Ferricade' })).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'ferricade')
  })

  test('applies theme and mode cascading tokens correctly across all palettes and modes', async ({
    page,
  }) => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const tokensRaw = fs.readFileSync(path.resolve(process.cwd(), 'src/styles/tokens.css'), 'utf-8')

    function getExpectedPrimary(palette: string, mode: 'light' | 'dark'): string {
      const esc = palette.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const selector =
        palette === 'indigo'
          ? mode === 'light'
            ? '^:root\\s*,\\s*\\[data-theme=["\']light["\']\\]'
            : '^\\[data-theme=["\']dark["\']\\]'
          : mode === 'light'
            ? `^\\[data-palette=["']${esc}["']\\],\\s*\\n\\[data-palette=["']${esc}["']\\]\\[data-theme=["']light["']\\]`
            : `^\\[data-palette=["']${esc}["']\\]\\[data-theme=["']dark["']\\]`
      const match = tokensRaw.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'))
      if (!match || !match[1]) {
        throw new Error(`Could not find ${palette} ${mode} block in tokens.css`)
      }
      const primMatch = match[1].match(/--primary\s*:\s*([^;]+);/)
      if (!primMatch || !primMatch[1]) {
        throw new Error(`Could not find --primary in ${palette} ${mode}`)
      }
      return primMatch[1].trim()
    }

    const palettes = [
      { name: 'Ferricade', key: 'ferricade' },
      { name: 'Indigo', key: 'indigo' },
      { name: 'Graphite', key: 'graphite' },
      { name: 'Ocean', key: 'ocean' },
      { name: 'Violet', key: 'violet' },
      { name: 'Moss', key: 'moss' },
      { name: 'Sandstone', key: 'sandstone' },
    ] as const

    await page.goto('/account/appearance')

    for (const { name, key } of palettes) {
      await page.getByRole('radio', { name }).locator('xpath=..').click()
      if (key === 'indigo') {
        await expect(page.locator('html')).not.toHaveAttribute('data-palette')
      } else {
        await expect(page.locator('html')).toHaveAttribute('data-palette', key)
      }

      // 1. Choose Light
      await page.getByRole('radio', { name: 'Light' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await expect
        .poll(() =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
          ),
        )
        .toBe(getExpectedPrimary(key, 'light'))

      // 2. Choose Dark
      await page.getByRole('radio', { name: 'Dark' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect
        .poll(() =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
          ),
        )
        .toBe(getExpectedPrimary(key, 'dark'))

      // 3. Choose System with emulateMedia dark
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.getByRole('radio', { name: 'System' }).click()
      await expect(page.locator('html')).not.toHaveAttribute('data-theme')
      await expect
        .poll(() =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
          ),
        )
        .toBe(getExpectedPrimary(key, 'dark'))

      // 4. Choose System with emulateMedia light
      await page.emulateMedia({ colorScheme: 'light' })
      await expect
        .poll(() =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
          ),
        )
        .toBe(getExpectedPrimary(key, 'light'))
    }
  })

  test('theme cards maintain equal width >= 200px across selections at 1280px viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/account/appearance')

    const cardLabels = [
      page.getByRole('radio', { name: 'Ferricade' }).locator('xpath=..'),
      page.getByRole('radio', { name: 'Indigo' }).locator('xpath=..'),
      page.getByRole('radio', { name: 'Graphite' }).locator('xpath=..'),
      page.getByRole('radio', { name: 'Ocean' }).locator('xpath=..'),
      page.getByRole('radio', { name: 'Violet' }).locator('xpath=..'),
      page.getByRole('radio', { name: 'Moss' }).locator('xpath=..'),
      page.getByRole('radio', { name: 'Sandstone' }).locator('xpath=..'),
    ]

    async function getCardWidths(): Promise<number[]> {
      const widths: number[] = []
      for (const card of cardLabels) {
        const box = await card.boundingBox()
        if (!box) throw new Error('Card bounding box not found')
        widths.push(box.width)
      }
      return widths
    }

    const initialWidths = await getCardWidths()

    await page.getByRole('radio', { name: 'Sandstone' }).locator('xpath=..').click()
    const sandstoneWidths = await getCardWidths()

    await page.getByRole('radio', { name: 'Violet' }).locator('xpath=..').click()
    const violetWidths = await getCardWidths()

    const allWidths = [...initialWidths, ...sandstoneWidths, ...violetWidths]
    console.log('Recorded card widths:', {
      initialWidths,
      sandstoneWidths,
      violetWidths,
    })

    for (const w of allWidths) {
      expect(w).toBeGreaterThanOrEqual(200)
    }

    const baseline = allWidths[0]!
    for (const w of allWidths) {
      expect(Math.abs(w - baseline)).toBeLessThanOrEqual(0.5)
    }
  })

  test('accent presence: sidebar nav-active, mode radio accent-color, and mini screen theme isolation', async ({
    page,
  }) => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const tokensRaw = fs.readFileSync(path.resolve(process.cwd(), 'src/styles/tokens.css'), 'utf-8')

    function hexToRgbString(hex: string): string {
      const clean = hex.replace('#', '').trim()
      const num = parseInt(clean, 16)
      return `rgb(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255})`
    }

    function getExpectedToken(palette: string, mode: 'light' | 'dark', tokenName: string): string {
      const esc = palette.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const selector =
        palette === 'indigo'
          ? mode === 'light'
            ? '^:root\\s*,\\s*\\[data-theme=["\']light["\']\\]'
            : '^\\[data-theme=["\']dark["\']\\]'
          : mode === 'light'
            ? `^\\[data-palette=["']${esc}["']\\],\\s*\\n\\[data-palette=["']${esc}["']\\]\\[data-theme=["']light["']\\]`
            : `^\\[data-palette=["']${esc}["']\\]\\[data-theme=["']dark["']\\]`
      const match = tokensRaw.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'))
      if (!match || !match[1]) {
        throw new Error(`Could not find ${palette} ${mode} block in tokens.css`)
      }
      const tokMatch = match[1].match(new RegExp(`${tokenName}\\s*:\\s*([^;]+);`))
      if (!tokMatch || !tokMatch[1]) {
        throw new Error(`Could not find ${tokenName} in ${palette} ${mode}`)
      }
      return tokMatch[1].trim()
    }

    const palettes = [
      { name: 'Ferricade', key: 'ferricade' },
      { name: 'Indigo', key: 'indigo' },
      { name: 'Graphite', key: 'graphite' },
      { name: 'Ocean', key: 'ocean' },
      { name: 'Violet', key: 'violet' },
      { name: 'Moss', key: 'moss' },
      { name: 'Sandstone', key: 'sandstone' },
    ] as const

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/account/appearance')

    for (const { name, key } of palettes) {
      await page.getByRole('radio', { name }).locator('xpath=..').click()

      for (const mode of ['Light', 'Dark'] as const) {
        const modeKey = mode.toLowerCase() as 'light' | 'dark'
        await page.getByRole('radio', { name: mode }).click()

        const expectedNavActive = hexToRgbString(getExpectedToken(key, modeKey, '--nav-active'))
        const expectedPrimary = hexToRgbString(getExpectedToken(key, modeKey, '--primary'))

        // Selected nav tab link (Appearance) computed background-color equals --nav-active
        const navLink = page
          .getByRole('navigation', { name: 'User settings tabs' })
          .getByRole('link', { name: 'Appearance' })
        await expect
          .poll(async () => {
            return navLink.evaluate((el) => getComputedStyle(el).backgroundColor)
          })
          .toBe(expectedNavActive)

        // Mode radio computed accent-color equals --primary
        const modeRadio = page.getByRole('radio', { name: mode })
        await expect
          .poll(async () => {
            return modeRadio.evaluate((el) => getComputedStyle(el).accentColor)
          })
          .toBe(expectedPrimary)
      }
    }

    // Mini screen theme isolation: Ocean selected, mode Dark under OS colorScheme light
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByRole('radio', { name: 'Ocean' }).locator('xpath=..').click()
    await page.getByRole('radio', { name: 'Dark' }).click()

    const ferricadeCard = page.getByRole('radio', { name: 'Ferricade' }).locator('xpath=..')
    const indigoCard = page.getByRole('radio', { name: 'Indigo' }).locator('xpath=..')

    const ferricadeDarkPrimary = hexToRgbString(getExpectedToken('ferricade', 'dark', '--primary'))
    const oceanDarkPrimary = hexToRgbString(getExpectedToken('ocean', 'dark', '--primary'))
    const ferricadeWordmark = ferricadeCard
      .locator('[data-brand-logo="wordmark"] [data-brand-part="ink"]')
      .first()
    const indigoWordmark = indigoCard
      .locator('[data-brand-logo="wordmark"] [data-brand-part="ink"]')
      .first()

    await expect
      .poll(async () => {
        return ferricadeCard
          .locator('[data-slot="preview-primary-btn"]')
          .evaluate((el) => getComputedStyle(el).backgroundColor)
      })
      .toBe(ferricadeDarkPrimary)

    await expect
      .poll(async () => {
        return page
          .getByRole('radio', { name: 'Ocean' })
          .locator('xpath=..')
          .locator('[data-slot="preview-primary-btn"]')
          .evaluate((el) => getComputedStyle(el).backgroundColor)
      })
      .toBe(oceanDarkPrimary)

    await page.getByRole('radio', { name: 'Ferricade' }).locator('xpath=..').click()
    await expect
      .poll(async () => ferricadeWordmark.evaluate((el) => getComputedStyle(el).fill))
      .not.toBe(await indigoWordmark.evaluate((el) => getComputedStyle(el).fill))
  })
})
