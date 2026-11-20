import { expect, test } from './support/test'

const phoneSizes = [
  { name: '360 x 800', width: 360, height: 800 },
  { name: '390 × 844', width: 390, height: 844 },
  { name: '320 × 700', width: 320, height: 700 },
] as const

async function expectNoPhoneOverflow(page: import('@playwright/test').Page, width: number) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector('main')
    const elements = main ? [...main.querySelectorAll('*')] : []
    const viewportWidth = window.innerWidth
    return {
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      outside: elements.flatMap((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          element.closest('.sr-only') ||
          !rect.width ||
          !rect.height
        )
          return []
        const card = element.closest('[data-slot="card"]') ?? main
        const cardBox = card?.getBoundingClientRect()
        return cardBox &&
          (rect.left < cardBox.left - 1 ||
            rect.top < cardBox.top - 1 ||
            rect.right > cardBox.right + 1 ||
            rect.bottom > cardBox.bottom + 1 ||
            rect.left < -1 ||
            rect.right > viewportWidth + 1)
          ? [
              {
                tag: element.tagName,
                className: typeof element.className === 'string' ? element.className : '',
                text: element.textContent?.trim().slice(0, 80),
                box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
              },
            ]
          : []
      }),
    }
  })
  expect(overflow.documentWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(width)
  expect(overflow.bodyWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(width)
  expect(overflow.outside, JSON.stringify(overflow)).toEqual([])
}

for (const viewport of phoneSizes) {
  test.describe(`Sessions and Audit at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true })

    test('Sessions has no horizontal overflow and keeps statuses and disconnect action visible', async ({
      page,
    }) => {
      await page.goto('/sessions?mock=large')
      await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()
      const rows = page.locator('[data-slot="session-row"]')
      await expect(rows.first()).toBeVisible()
      const statuses = rows
        .locator('[data-slot="badge"]')
        .filter({ hasText: /^(Open|Attempt|Disconnected|Stale|Closed)$/ })
      for (const status of await statuses.all()) {
        const box = await status.boundingBox()
        expect(box, 'session status has a rendered box').not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
        expect(
          await status.evaluate((element) => element.scrollWidth <= element.clientWidth),
          'session status text is not clipped',
        ).toBe(true)
      }
      const disconnect = rows.getByRole('button', { name: /^Disconnect .+ from / }).first()
      if (await disconnect.count()) {
        const box = await disconnect.boundingBox()
        expect(box, 'disconnect action has a rendered box').not.toBeNull()
        expect(box!.width).toBeGreaterThanOrEqual(44)
        expect(box!.height).toBeGreaterThanOrEqual(44)
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
      }
      await expectNoPhoneOverflow(page, viewport.width)
    })

    test('Sessions filter controls share full-width edges', async ({ page }) => {
      await page.goto('/sessions?mock=large')
      const filter = page.locator('[data-slot="sessions-filter-bar"]')
      await expect(filter).toBeVisible()
      const select = filter.getByRole('combobox')
      const time = filter.getByRole('button', { name: 'All time' }).locator('..')
      const attempts = filter.locator('label[for="include-attempts-switch"]').locator('..')
      const boxes = await Promise.all([select, time, attempts].map((item) => item.boundingBox()))
      expect(boxes.every(Boolean), 'filter controls have rendered boxes').toBe(true)
      const lefts = boxes.map((box) => box!.x)
      const rights = boxes.map((box) => box!.x + box!.width)
      expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThanOrEqual(2)
      expect(Math.max(...rights) - Math.min(...rights)).toBeLessThanOrEqual(2)
    })

    test('Audit action codes and actor lines stay inside each card', async ({ page }) => {
      await page.goto('/audit?mock=large')
      await expect(page.getByRole('heading', { level: 1, name: 'Audit Log' })).toBeVisible()
      const entries = page.locator('[data-slot="audit-event-item"]')
      await expect(entries.first()).toBeVisible()
      for (const entry of await entries.all()) {
        const content = await entry.evaluate((element) => {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return {
            left: rect.left + parseFloat(style.paddingLeft),
            right: rect.right - parseFloat(style.paddingRight),
          }
        })
        for (const text of [entry.locator('.font-mono').last(), entry.getByText(/^from /)]) {
          const box = await text.boundingBox()
          expect(box, 'audit text has a rendered box').not.toBeNull()
          expect(box!.x).toBeGreaterThanOrEqual(content.left - 1)
          expect(box!.x + box!.width).toBeLessThanOrEqual(content.right + 1)
        }
      }
      await expectNoPhoneOverflow(page, viewport.width)
    })
  })
}

test.describe('Sessions desktop layout', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('still renders a sessions table', async ({ page }) => {
    await page.goto('/sessions?mock=large')
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()
    await expect(page.getByRole('table')).toBeVisible()
  })
})
