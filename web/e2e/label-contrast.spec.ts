import AxeBuilder from '@axe-core/playwright'
import { PALETTES } from '../src/lib/appearance'
import { expect, mockReady, test } from './support/test'

const pages = [
  '/',
  '/devices',
  '/devices/:id',
  '/devices/queue',
  '/groups',
  '/tags',
  '/sessions',
  '/settings/users',
]

for (const palette of PALETTES) {
  for (const theme of ['light', 'dark'] as const) {
    test(`coloured labels pass axe contrast on ${palette} ${theme}`, async ({ page }) => {
      for (const path of pages) {
        if (path === '/devices/:id') {
          await page.goto('/devices')
          await mockReady(page)
          const id = await page.evaluate(() => window.__ferricadeMock!.approvedDeviceId())
          await page.goto(`/devices/${id}`)
        } else {
          await page.goto(path)
        }
        await expect(page.locator('h1')).toBeVisible()
        await page.evaluate(
          ({ palette, theme }) => {
            document.documentElement.dataset.palette = palette
            document.documentElement.dataset.theme = theme
          },
          { palette, theme },
        )

        const results = await new AxeBuilder({ page })
          .include('[data-slot="tag-pill"]')
          .include('[data-slot="tag-label"]')
          .include('[data-slot="badge"]')
          .withRules(['color-contrast'])
          .analyze()
        expect(
          results.violations,
          `${path} (${palette} ${theme}): ${JSON.stringify(
            results.violations.map((violation) => ({
              nodes: violation.nodes.map((node) => node.html),
            })),
          )}`,
        ).toEqual([])
      }
    })
  }
}
