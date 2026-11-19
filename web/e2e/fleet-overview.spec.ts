import { expect, test } from './support/test'

const moduleSelector = '[data-module-id="fleet-overview"]'

async function ensurePreset(page: import('@playwright/test').Page, preset: 'business' | 'wall') {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
  const wallActive = await page.getByRole('button', { name: 'Change layout' }).isVisible()
  if ((preset === 'wall') !== wallActive) {
    await page.getByRole('button', { name: wallActive ? 'Change layout' : 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await expect(drawer).toBeVisible()
    await drawer
      .getByRole('button', { name: preset === 'wall' ? 'Monitoring wall' : 'Business' })
      .click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
    await expect(drawer).toBeHidden()
    await expect(
      page.getByRole('button', { name: preset === 'wall' ? 'Change layout' : 'Customize' }),
    ).toBeVisible()
  }

  if (preset === 'business') {
    const module = page.locator(moduleSelector)
    if (
      (await module.getAttribute('data-cols')) !== '4' ||
      (await module.getAttribute('data-rows')) !== '2'
    ) {
      await page.getByRole('button', { name: 'Customize' }).click()
      const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
      await expect(drawer).toBeVisible()
      await drawer
        .getByRole('group', { name: 'Size for fleet-overview' })
        .getByRole('button', { name: 'medium size' })
        .click()
      await drawer.getByRole('button', { name: 'Save layout' }).click()
      await expect(drawer).toBeHidden()
      await expect(module).toHaveAttribute('data-cols', '4')
    }
  }
}

test.describe('Fleet overview', () => {
  test('fits its card, scrolls its mock fleet, and orders nodes by status', async ({ page }) => {
    await ensurePreset(page, 'business')
    const module = page.locator(moduleSelector)
    await expect(module).toBeVisible()
    const geometry = await module.evaluate((card) => {
      const cardBox = card.getBoundingClientRect()
      const body = card.querySelector<HTMLElement>('[data-slot="fleet-overview-body"]')!
      const outside = [...card.querySelectorAll<HTMLElement>('*')]
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ el, rect }) => {
          const style = getComputedStyle(el)
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            !rect.width ||
            !rect.height
          )
            return false
          return (
            rect.left < cardBox.left - 1 ||
            rect.top < cardBox.top - 1 ||
            rect.right > cardBox.right + 1 ||
            rect.bottom > cardBox.bottom + 1
          )
        })
        .map(
          ({ el, rect }) =>
            `${el.tagName.toLowerCase()}${el.getAttribute('data-slot') ? `[${el.getAttribute('data-slot')}]` : ''}: ${Math.round(rect.left)},${Math.round(rect.top)}-${Math.round(rect.right)},${Math.round(rect.bottom)}`,
        )
      return {
        outside,
        scrollHeight: body.scrollHeight,
        clientHeight: body.clientHeight,
        overflowY: getComputedStyle(body).overflowY,
      }
    })
    expect(geometry.outside, 'Fleet overview descendants should stay inside the card').toEqual([])
    expect(
      geometry.scrollHeight > geometry.clientHeight || geometry.overflowY === 'auto',
      'Fleet overview body should scroll or expose vertical auto overflow',
    ).toBe(true)

    const rows = module.locator('[data-slot="fleet-group-content"]')
    const nodes = module.getByRole('link', { name: /, (alert|offline|online)$/ })
    expect(
      await nodes.count(),
      'the medium fleet should expose clickable device nodes',
    ).toBeGreaterThan(0)
    for (const row of await rows.all()) {
      const ranks = await row
        .getByRole('link', { name: /, (alert|offline|online)$/ })
        .evaluateAll((links) =>
          links.map((link) => {
            const name = link.getAttribute('aria-label') ?? ''
            return name.endsWith(', alert') ? 0 : name.endsWith(', offline') ? 1 : 2
          }),
        )
      expect(ranks, 'nodes in each row should be alert, offline, then online').toEqual(
        [...ranks].sort((a, b) => a - b),
      )
    }
  })

  test('rolls up parent counts and persists subgroup expansion across reload', async ({ page }) => {
    await ensurePreset(page, 'business')
    const module = page.locator(moduleSelector)
    const officeHeader = module
      .locator('[data-slot="fleet-group-header"]')
      .filter({ hasText: 'Office' })
    await expect(officeHeader).toContainText(/\d+\/[1-9]\d*/)

    await module.getByRole('button', { name: 'Expand Office' }).click()
    await expect(module.getByRole('link', { name: 'Reception', exact: true })).toBeVisible()
    await expect(module.getByRole('link', { name: 'Engineering', exact: true })).toBeVisible()
    await module.getByRole('button', { name: 'Collapse Office' }).click()
    await expect(module.getByRole('link', { name: 'Reception', exact: true })).toBeHidden()
    await module.getByRole('button', { name: 'Expand Office' }).click()
    await page.reload()
    await expect(
      page.locator(moduleSelector).getByRole('link', { name: 'Reception', exact: true }),
    ).toBeVisible()
  })

  test('opens the device panel from a node', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await ensurePreset(page, 'business')
    const module = page.locator(moduleSelector)
    const node = module.getByRole('link', { name: /, (alert|offline|online)$/ }).first()
    const [deviceName] = (await node.getAttribute('aria-label'))!.split(', ')
    await node.click()
    await expect(
      page.getByRole('heading', { level: 2, name: deviceName, exact: true }),
    ).toBeVisible()
  })

  test('filters Devices from the selected group and its subgroups', async ({ page }) => {
    await ensurePreset(page, 'business')
    await page.goto('/')
    await expect(
      page.locator(moduleSelector).getByRole('link', { name: 'Office', exact: true }),
    ).toBeVisible()
    const office = page.locator(moduleSelector).getByRole('link', { name: 'Office', exact: true })
    const href = await office.getAttribute('href')
    await office.click()
    await expect(page).toHaveURL(/\/devices\?/)
    const url = new URL(page.url())
    expect(url.searchParams.get('group')).toBe(new URL(href!, page.url()).searchParams.get('group'))
    expect(url.searchParams.get('subgroups')).toBe('true')
  })

  test('fits the card without horizontal page scroll at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await ensurePreset(page, 'business')
    const module = page.locator(moduleSelector)
    await expect(module).toBeVisible()
    const sizes = await page.evaluate(() => ({
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }))
    expect(sizes.pageWidth).toBeLessThanOrEqual(sizes.viewportWidth)
    const fits = await module.evaluate((card) => {
      const cardBox = card.getBoundingClientRect()
      return [...card.querySelectorAll<HTMLElement>('*')].every((el) => {
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return true
        const rect = el.getBoundingClientRect()
        return (
          !rect.width ||
          !rect.height ||
          (rect.left >= cardBox.left - 1 &&
            rect.top >= cardBox.top - 1 &&
            rect.right <= cardBox.right + 1 &&
            rect.bottom <= cardBox.bottom + 1)
        )
      })
    })
    expect(fits, 'Fleet overview descendants should stay inside the card on phone').toBe(true)
  })

  test('wall display shows only top-level rows without expand buttons', async ({ page }) => {
    await ensurePreset(page, 'wall')
    await page.goto('/?kiosk=1')
    const module = page.locator(moduleSelector)
    await expect(module.locator('[data-slot="fleet-overview-wall"]')).toBeVisible()
    await expect(module.getByRole('button', { name: /^Expand / })).toHaveCount(0)
    const topLevelRows = module.locator('[data-slot="fleet-overview-wall"] > ul > li')
    expect(await topLevelRows.count()).toBeGreaterThan(0)
    for (const row of await topLevelRows.all()) {
      await expect(row.locator(':scope > ul')).toHaveCount(0)
    }
  })
})
