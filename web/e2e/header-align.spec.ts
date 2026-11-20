import { expect, test } from './support/test'

// The sidebar's brand row and the top bar sit side by side; their bottom borders
// must be one continuous line wherever the sidebar is shown (md and up).
const cases = [
  { name: 'tablet 768x1024', width: 768, height: 1024, touch: true },
  { name: 'tablet 820x1180', width: 820, height: 1180, touch: true },
  { name: 'tablet 1024x768', width: 1024, height: 768, touch: true },
  { name: 'tablet 1180x820', width: 1180, height: 820, touch: true },
  { name: 'desktop 1440x900', width: 1440, height: 900, touch: false },
  { name: 'short desktop 1280x600', width: 1280, height: 600, touch: false },
  {
    name: 'tablet 820x1180 fractional font',
    width: 820,
    height: 1180,
    touch: true,
    deviceScaleFactor: 2,
    rootFontSize: '18.3px',
  },
  {
    name: 'tablet 1180x820 fractional font',
    width: 1180,
    height: 820,
    touch: true,
    deviceScaleFactor: 2,
    rootFontSize: '18.3px',
  },
  {
    name: 'tablet 820x1180 fractional device scale',
    width: 820,
    height: 1180,
    touch: true,
    deviceScaleFactor: 1.5,
  },
]

for (const c of cases) {
  test.describe(c.name, () => {
    test.use({
      viewport: { width: c.width, height: c.height },
      hasTouch: c.touch,
      deviceScaleFactor: 'deviceScaleFactor' in c ? c.deviceScaleFactor : 1,
    })

    for (const collapsed of [false, true]) {
      test(`brand row and top bar line up, sidebar ${collapsed ? 'collapsed' : 'expanded'}`, async ({
        page,
      }) => {
        if ('rootFontSize' in c) {
          await page.addInitScript((fontSize) => {
            const observer = new MutationObserver(() => {
              if (document.documentElement) {
                document.documentElement.style.fontSize = fontSize
                observer.disconnect()
              }
            })
            observer.observe(document, { childList: true })
          }, c.rootFontSize)
        }
        await page.goto('/devices')
        await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
        if ('rootFontSize' in c) {
          expect(
            await page.evaluate(() => getComputedStyle(document.documentElement).fontSize),
          ).toBe(c.rootFontSize)
        }
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(c.touch)

        if (collapsed) {
          await page.getByRole('button', { name: 'Unpin sidebar' }).click()
          await page.mouse.move(500, 500)
          await page.evaluate(() => (document.activeElement as HTMLElement).blur())
          await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeHidden()
        }
        await expect(page.locator('aside [data-slot="sidebar-header"]')).toBeVisible()

        const brandRow = page.locator('aside [data-slot="sidebar-header"]')
        const bottoms = async () => {
          const [row, header] = await Promise.all([
            brandRow.boundingBox(),
            page.locator('header').boundingBox(),
          ])
          expect(row).not.toBeNull()
          expect(header).not.toBeNull()
          return {
            rowTop: row!.y,
            headerTop: header!.y,
            row: row!.y + row!.height,
            header: header!.y + header!.height,
            rowHeight: row!.height,
            headerHeight: header!.height,
          }
        }
        // The published height is applied by an effect; wait for it to settle.
        await expect
          .poll(
            async () => {
              const b = await bottoms()
              return Math.abs(b.row - b.header)
            },
            { message: JSON.stringify(await bottoms()) },
          )
          .toBeLessThanOrEqual(0.05)
        const aligned = await bottoms()
        expect(
          Math.abs(aligned.rowTop - aligned.headerTop),
          JSON.stringify(aligned),
        ).toBeLessThanOrEqual(0.05)
      })
    }
  })
}
