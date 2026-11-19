import { expect, test } from './support/test'

const longPeerId = '34500423@198.51.100.152:21116'

async function assertRowsFit(page: import('@playwright/test').Page, keepWideLayout = false) {
  const items = page.locator('[data-slot="live-session-item"]')
  await expect(items).not.toHaveCount(0)
  await expect(items.filter({ hasText: longPeerId })).toHaveCount(1)

  for (const item of await items.all()) {
    const rowBox = await item.boundingBox()
    expect(rowBox).not.toBeNull()
    const overflows = await item.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(overflows, 'live session row should not overflow').toBe(false)

    const badge = item.locator('[data-slot="badge"]')
    const duration = item.locator(':scope > div').nth(1)
    const badgeBox = await badge.boundingBox()
    const durationBox = await duration.boundingBox()
    const id = item.locator('[data-slot="mono-id"]')
    const idBox = await id.boundingBox()
    expect(badgeBox).not.toBeNull()
    expect(durationBox).not.toBeNull()
    expect(idBox).not.toBeNull()
    expect(
      badgeBox!.x + badgeBox!.width <= durationBox!.x ||
        durationBox!.x + durationBox!.width <= badgeBox!.x ||
        badgeBox!.y + badgeBox!.height <= durationBox!.y ||
        durationBox!.y + durationBox!.height <= badgeBox!.y,
      'type badge and duration chip should not intersect',
    ).toBe(true)
    for (const child of [badgeBox!, idBox!]) {
      expect(child.x).toBeGreaterThanOrEqual(rowBox!.x - 1)
      expect(child.y).toBeGreaterThanOrEqual(rowBox!.y - 1)
      expect(child.x + child.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1)
      expect(child.y + child.height).toBeLessThanOrEqual(rowBox!.y + rowBox!.height + 1)
    }
  }

  if (keepWideLayout) {
    const item = items.filter({ hasText: longPeerId }).first()
    const nameBox = await item.locator('[data-slot="wall-row-primary"]').boundingBox()
    const durationBox = await item.locator(':scope > div').nth(1).boundingBox()
    expect(nameBox).not.toBeNull()
    expect(durationBox).not.toBeNull()
    expect(Math.abs(nameBox!.y - durationBox!.y)).toBeLessThanOrEqual(4)
  }
}

async function setSmall(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Customize' }).click()
  const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
  await expect(drawer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  const module = page.locator('[data-module-id="live-sessions"]')
  await module.getByRole('button', { name: 'small size' }).click()
  await expect(module).toHaveAttribute('data-cols', '1')
  await expect(module).toHaveAttribute('data-rows', '2')
  await page.getByRole('button', { name: 'Save layout' }).click()
  await expect(page.locator('[data-edit-mode="true"]')).toHaveCount(0)
}

// Which sessions are live, and in what order, once came from a mock built on the
// clock (the fixture draws start times by the hour). Run every case at times that
// differ in local and UTC hour, so a clock-dependent fixture fails here.
const at = (hour: number, minute: number) => new Date(2026, 9, 13, hour, minute)

for (const [hour, minute] of [
  [0, 30],
  [9, 0],
  [17, 0],
  [23, 30],
] as const) {
  const when = `at ${hour}:${String(minute).padStart(2, '0')}`

  test(`small live sessions rows fit at desktop width ${when}`, async ({ page }) => {
    await page.clock.install({ time: at(hour, minute) })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await setSmall(page)
    await expect(page.locator('[data-module-id="live-sessions"]')).toHaveAttribute('data-cols', '1')
    await assertRowsFit(page)
  })

  test(`default live sessions keep their wide layout at desktop width ${when}`, async ({
    page,
  }) => {
    await page.clock.install({ time: at(hour, minute) })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await assertRowsFit(page, true)
  })

  test(`default live sessions rows fit on a phone ${when}`, async ({ page }) => {
    await page.clock.install({ time: at(hour, minute) })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await assertRowsFit(page)
  })
}
