import { expect, test } from './support/test'

test('About label aligns with System Settings in desktop and phone navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const textOffset = (scopeSelector: string) =>
    page.evaluate((selector) => {
      const scope = document.querySelector(selector)
      if (!scope) throw new Error(`Could not find ${selector}`)
      const label = (tag: 'button' | 'a', text: string) => {
        const item = Array.from(scope.querySelectorAll(tag)).find(
          (element) => element.querySelector('span')?.textContent?.trim() === text,
        )
        const span = item?.querySelector('span')
        if (!span) throw new Error(`Could not find ${text} label in ${selector}`)
        const range = document.createRange()
        range.selectNodeContents(span)
        return range.getBoundingClientRect().left
      }
      return Math.abs(label('button', 'About') - label('a', 'System Settings'))
    }, scopeSelector)

  await expect(page.locator('aside')).toBeVisible()
  const misaligned: string[] = []
  try {
    await expect.poll(() => textOffset('aside')).toBeLessThanOrEqual(1)
  } catch {
    misaligned.push(`desktop: ${await textOffset('aside')} px`)
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  try {
    await expect.poll(() => textOffset('[role="dialog"]')).toBeLessThanOrEqual(1)
  } catch {
    misaligned.push(`phone: ${await textOffset('[role="dialog"]')} px`)
  }
  expect(misaligned).toEqual([])
})

test('About dialog opens from sidebar, switches changelog releases, and restores focus', async ({
  page,
}) => {
  await page.goto('/')
  const about = page.getByRole('button', { name: 'About', exact: true })
  await about.click()
  const dialog = page.getByRole('dialog', { name: 'About Ferricade' })
  await expect(
    dialog.locator('p').filter({ hasText: /^Version \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/ }),
  ).toBeVisible()
  await dialog.getByRole('tab', { name: 'Changelog' }).click()
  const releases = dialog.locator('details[data-slot="changelog-release"]')
  await expect(releases.first()).toHaveAttribute('open', '')
  await releases.nth(1).locator('summary').click()
  await expect(releases.nth(1)).toHaveAttribute('open', '')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(about).toBeFocused()

  await page.getByRole('button', { name: 'Unpin sidebar' }).click()
  await page.mouse.move(500, 500)
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  await expect(page.getByRole('button', { name: 'Pin sidebar' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'About' })).toHaveAttribute('aria-label', 'About')
})

test('About opens from the phone navigation menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  await page.getByRole('button', { name: 'About', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'About Ferricade' })).toBeVisible()
})
