import { expect, test } from './support/test'

test.use({ locale: 'en-US', timezoneId: 'UTC' })

type HistoryPoint = { at: string; sessions: number }
type History = { points: HistoryPoint[] }

function laterNonzeroPoint(points: HistoryPoint[]) {
  const seenDays = new Set<string>()
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!
    const day = point.at.slice(0, 10)
    const isLaterSameDayPoint = seenDays.has(day)
    seenDays.add(day)
    if (isLaterSameDayPoint && point.sessions > 0) return { ...point, index }
  }
  throw new Error('History has no later same-day point with sessions')
}

test('Activity Trend tooltips resolve same-day 7d and 30d session points', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-12T12:00:00Z'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?mock=large')
  const card = page.locator('[data-module-id="activity-trend"]')
  await card.scrollIntoViewIfNeeded()

  for (const range of ['7d', '30d'] as const) {
    const historyResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname.endsWith('/stats/history') && url.searchParams.get('range') === range
    })
    await card.getByRole('button', { name: range }).click()
    const response = await historyResponse
    const history = (await response.json()) as History
    const point = laterNonzeroPoint(history.points)
    const date = new Date(point.at)
    const expectedDate = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    })
    const expectedTime = date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    })

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await card.scrollIntoViewIfNeeded()
      const sessionsPath = card.locator('.recharts-area-curve').nth(1)
      await expect
        .poll(
          async () => {
            const first = await sessionsPath.getAttribute('d')
            if (!first) return false
            await page.waitForTimeout(200)
            const second = await sessionsPath.getAttribute('d')
            if (first !== second) return false
            await page.waitForTimeout(200)
            return second === (await sessionsPath.getAttribute('d'))
          },
          { intervals: [100, 200], timeout: 10_000 },
        )
        .toBe(true)
      // SVG geometry excludes the stroke; round to the pixel Chromium will send.
      const plot = await card
        .locator('.recharts-cartesian-grid')
        .evaluate((grid: SVGGraphicsElement) => {
          const box = grid.getBBox()
          const matrix = grid.getScreenCTM()!
          const start = new DOMPoint(box.x, box.y).matrixTransform(matrix)
          const end = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix)
          return { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y }
        })
      expect(plot.width, `${range} plot area missing at ${width}px`).toBeGreaterThan(0)
      const x = plot.x + (point.index / (history.points.length - 1)) * plot.width
      await page.mouse.move(Math.round(x), plot.y + plot.height / 2)

      const tooltip = card.locator('.recharts-tooltip-wrapper')
      await expect(tooltip).toContainText(`Active sessions : ${point.sessions}`)
      await expect(tooltip).toContainText(`${expectedDate} ${expectedTime}`)
    }
  }
})
