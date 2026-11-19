import AxeBuilder from '@axe-core/playwright'
import { ROUTES } from './support/routes'
import { expect, mockReady, test } from './support/test'

const ALLOWED_ERRORS =
  /status of (401|423) .*\/admin\/api\/v1\/auth\/(me|login)|status of (400|423) .*\/admin\/api\/v1\/auth\/totp/

test.describe('Accessibility pass (axe-core WCAG 2.1 AA)', () => {
  test.use({ allowConsoleErrors: [ALLOWED_ERRORS] })

  const themes: ('light' | 'dark')[] = ['light', 'dark']

  for (const theme of themes) {
    for (const route of ROUTES) {
      test(`${route.heading} (${route.path}) has zero critical/serious a11y violations in ${theme} mode`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: theme })
        let path = route.path
        if (route.id) {
          await page.goto('/devices')
          await mockReady(page)
          const id = await page.evaluate(() => window.__ferricadeMock!.approvedDeviceId())
          path = path.replace('$id', id)
        }
        const url = route.query ? `${path}?${route.query}` : path
        await page.goto(url)
        await page.waitForLoadState('domcontentloaded')
        await expect(
          page.getByRole('heading', { level: 1, name: route.heading, exact: true }),
        ).toBeVisible()
        await page.evaluate((t) => {
          document.documentElement.setAttribute('data-theme', t)
        }, theme)

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()

        const severe = results.violations.filter(
          (v) => v.impact === 'critical' || v.impact === 'serious',
        )
        expect(
          severe,
          `Accessibility violations on ${path} (${theme} mode):\n${JSON.stringify(
            severe.map((s) => ({
              id: s.id,
              impact: s.impact,
              description: s.description,
              nodes: s.nodes.map((n) => n.html),
            })),
            null,
            2,
          )}`,
        ).toEqual([])
      })
    }

    test(`Signed-out sign-in (/sign-in?mock-session=signed-out) has zero critical/serious a11y violations in ${theme} mode`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/sign-in?mock-session=signed-out')
      await page.waitForLoadState('domcontentloaded')
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
      await page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t)
      }, theme)

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()

      const severe = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      )
      expect(severe).toEqual([])
    })

    test(`Command palette has zero critical/serious a11y violations in ${theme} mode`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/')
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('h1')).toBeVisible()
      await page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t)
      }, theme)

      const trigger = page.locator('header').getByRole('button', { name: /Search \((Ctrl K|⌘K)\)/ })
      await trigger.click()
      const palette = page.locator('[data-slot="command-dialog"]')
      await expect(palette).toBeVisible()

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()

      const severe = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      )
      expect(severe).toEqual([])
    })

    test(`Device detail panel has zero critical/serious a11y violations in ${theme} mode`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/devices')
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('h1')).toBeVisible()
      await page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t)
      }, theme)

      const firstDevice = page.locator('[data-slot="devices-table"] tbody tr a').first()
      await firstDevice.click()

      const panel = page.locator('[data-slot="device-detail"]')
      await expect(panel).toBeVisible()

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()

      const severe = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      )
      expect(severe).toEqual([])
    })

    for (const tab of ['About', 'Changelog'] as const) {
      test(`About dialog ${tab} tab has zero critical/serious a11y violations in ${theme} mode`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: theme })
        await page.goto('/')
        await page.waitForLoadState('domcontentloaded')
        await page.getByRole('button', { name: 'About', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'About Ferricade' })
        await dialog.getByRole('tab', { name: tab }).click()
        await page.evaluate((t) => {
          document.documentElement.setAttribute('data-theme', t)
        }, theme)

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
        expect(
          results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
        ).toEqual([])
      })
    }
  }

  test('Skip to content link is present, visible on focus, and targets #main-content', async ({
    page,
  }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const skipLink = page.getByRole('link', { name: 'Skip to content' })
    await expect(skipLink).toHaveAttribute('href', '#main-content')

    // Tab to focus the skip link
    await page.keyboard.press('Tab')
    await expect(skipLink).toBeFocused()
    await expect(skipLink).toBeVisible()

    // Activate the skip link
    await page.keyboard.press('Enter')

    const mainContent = page.locator('#main-content')
    await expect(mainContent).toBeFocused()
  })
})
