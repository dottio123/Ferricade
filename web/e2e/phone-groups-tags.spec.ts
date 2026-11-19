import { expect, test } from './support/test'

const phoneSizes = [
  { name: '390 × 844', width: 390, height: 844 },
  { name: '360 × 740', width: 360, height: 740 },
] as const

async function expectNoPhoneOverflow(page: import('@playwright/test').Page, width: number) {
  const overflow = await page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const elements = [...document.querySelectorAll('*')].filter(visible)
    const scrollContainers = elements.filter((element) => {
      const style = getComputedStyle(element)
      return (
        (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
        element.scrollWidth > element.clientWidth
      )
    })
    return {
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      scrollContainers: scrollContainers.map((element) => ({
        tag: element.tagName,
        className: typeof element.className === 'string' ? element.className : '',
      })),
      elementsPastRightEdge: elements
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            tag: element.tagName,
            className: typeof element.className === 'string' ? element.className : '',
            text: element.textContent?.trim().slice(0, 80),
            left: rect.left,
            right: rect.right,
            width: rect.width,
          }
        }),
    }
  })
  expect(overflow.documentWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(width)
  expect(overflow.bodyWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(width)
  expect(overflow.scrollContainers, JSON.stringify(overflow)).toEqual([])
  expect(overflow.elementsPastRightEdge, JSON.stringify(overflow)).toEqual([])
}

for (const viewport of phoneSizes) {
  test.describe(`Groups and Tags at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true })

    test('Groups has no horizontal overflow and shows the subgroup count badge', async ({
      page,
    }) => {
      await page.goto('/groups')
      await expect(page.getByRole('heading', { level: 1, name: 'Groups' })).toBeVisible()
      const office = page.locator('[data-slot="group-node"]').filter({ hasText: 'Office' }).first()
      const count = office.locator('[data-slot="group-count"][aria-label*="including subgroups"]')
      await expect(count).toBeVisible()
      await expect
        .poll(async () => count.evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true)
      await expectNoPhoneOverflow(page, viewport.width)
    })

    test('Tags has no horizontal overflow', async ({ page }) => {
      await page.goto('/tags')
      await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible()
      await expect(page.locator('[data-slot="tag-row"]').first()).toBeVisible()
      await expectNoPhoneOverflow(page, viewport.width)
    })
  })
}

test.describe('Tags actions at 390 × 844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('every tag Edit and Delete action is visible and at least 44 × 44 px', async ({ page }) => {
    await page.goto('/tags')
    await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible()
    const rows = page.locator('[data-slot="tag-row"]')
    await expect(rows.first()).toBeVisible()
    const tagNames = await rows
      .locator('button[aria-label^="Edit tag "]')
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute('aria-label')!.replace('Edit tag ', '')),
      )
    expect(tagNames.length).toBeGreaterThan(0)

    for (const name of tagNames) {
      const row = page
        .locator('[data-slot="tag-row"]')
        .filter({ has: page.getByText(name, { exact: true }) })
        .first()
      for (const action of ['Edit', 'Delete'] as const) {
        const control = row.getByRole('button', { name: `${action} tag ${name}` })
        await expect(control).toBeVisible()
        const box = await control.boundingBox()
        expect(box, `${action} tag ${name} has a rendered box`).not.toBeNull()
        expect(box!.width, `${action} tag ${name} width`).toBeGreaterThanOrEqual(44)
        expect(box!.height, `${action} tag ${name} height`).toBeGreaterThanOrEqual(44)
        await control.click()
        await expect(
          page.getByRole('heading', { name: action === 'Edit' ? 'Edit tag' : 'Delete tag' }),
        ).toBeVisible()
        await page.getByRole('button', { name: 'Cancel' }).click()
      }
    }
  })
})

test.describe('Tags desktop layout', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('still renders the tags table', async ({ page }) => {
    await page.goto('/tags')
    await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible()
    await expect(page.getByRole('table')).toBeVisible()
  })
})
