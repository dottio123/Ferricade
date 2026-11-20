import AxeBuilder from '@axe-core/playwright'
import { expect, mockReady, test } from './support/test'

test.describe('390px phone viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('does not widen the page', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await expect(page.locator('[data-slot="dashboard-grid"]')).toBeVisible()
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyWidth: document.body.scrollWidth,
      elements: [...document.querySelectorAll('*')]
        .filter(
          (element) =>
            element.scrollWidth > element.clientWidth ||
            element.getBoundingClientRect().right > 389,
        )
        .slice(0, 30)
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          left: element.getBoundingClientRect().left,
          right: element.getBoundingClientRect().right,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        })),
    }))
    expect(overflow.width, JSON.stringify(overflow)).toBeLessThanOrEqual(390)
  })
})

test('relay failure opens a diagnosis panel, then Check now clears the issue', async ({ page }) => {
  await page.goto('/')
  await mockReady(page)
  await page.evaluate(() =>
    window.__ferricadeMock!.setServerCheck('relay', false, 'relay connection refused'),
  )
  await expect(
    page.getByRole('button', { name: 'Connection status: RustDesk server issue' }),
  ).toBeVisible({ timeout: 35_000 })
  const trigger = page.getByRole('button', { name: 'Connection status: RustDesk server issue' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const panel = page.locator('[data-slot="popover-content"]')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('Relay (hbbr)')).toBeVisible()
  await expect(
    panel.getByText(
      'Nothing accepts connections at 203.0.113.10:21117. Is that the machine running the RustDesk server, with its ports published?',
    ),
  ).toBeVisible()
  await expect(panel.getByText('rd.example.com:21117 → 203.0.113.10:21117')).toBeVisible()
  await expect(panel.getByText('relay connection refused')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Details' }).click()
  await expect(panel.getByRole('button', { name: 'Details' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(panel.getByText('relay connection refused')).toBeVisible()
  await panel.getByRole('button', { name: 'Details' }).click()
  await expect(panel.getByText('relay connection refused')).toHaveCount(0)
  await expect(panel.getByText('→ 203.0.113.10:21116')).toBeVisible()
  await expect(panel.getByText('Failing')).toBeVisible()
  const results = await new AxeBuilder({ page })
    .include('[data-slot="popover-content"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.evaluate(() => window.__ferricadeMock!.setServerCheck('relay', true))
  await panel.getByRole('button', { name: 'Check now' }).click()
  await expect(page.getByRole('button', { name: 'Connection status: Live' })).toBeVisible()
})

test('a User sees failed rows without diagnostic text or staff controls', async ({ page }) => {
  await page.goto('/?mock-role=user')
  await mockReady(page)
  await page.evaluate(() =>
    window.__ferricadeMock!.setServerCheck('relay', false, 'private relay error'),
  )
  await expect(
    page.getByRole('button', { name: 'Connection status: RustDesk server issue' }),
  ).toBeVisible({ timeout: 35_000 })
  await page.getByRole('button', { name: 'Connection status: RustDesk server issue' }).click()
  const panel = page.locator('[data-slot="popover-content"]')
  await expect(panel.getByText('Relay (hbbr)')).toBeVisible()
  await expect(panel.getByText('Failing')).toBeVisible()
  await expect(panel.getByText('private relay error')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Check now' })).toHaveCount(0)
  await expect(panel.getByText('If this persists, tell an administrator.')).toBeVisible()
})

test.describe('admin API outage', () => {
  test.use({
    allowConsoleErrors: [
      /Failed to load resource: net::ERR_FAILED \(https?:\/\/[^/]+\/admin\/api\/v1\/|TypeError: Failed to fetch/,
    ],
  })
  test('takes precedence over RustDesk health', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/')
    await mockReady(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connection status: Live' })).toBeVisible()
    await page.evaluate(() => {
      window.__ferricadeMock!.setServerCheck('relay', false, 'relay connection refused')
      window.__ferricadeMock!.takeServerOffline(20_000)
    })
    await expect(
      page.getByRole('button', { name: 'Connection status: Server offline' }),
    ).toBeVisible({ timeout: 25_000 })
    await page.getByRole('button', { name: 'Connection status: Server offline' }).click()
    await expect(page.getByText(/Server not answering since/)).toBeVisible()
  })
})
