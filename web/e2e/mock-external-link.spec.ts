// Opening a rustdesk:// link fires beforeunload although the page stays
// (Chromium does this for external-protocol navigations). MSW took that as the
// page closing and stopped mocking it, so every later request missed the mock
// API (404 from the static server). src/mocks/browser.ts keeps the mock on.
import { expect, mockReady, test } from './support/test'

test('the mock API keeps answering after a rustdesk:// link is opened', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
  await mockReady(page)

  await page.evaluate(() => window.location.assign('rustdesk://123456789@rd.example.com?key=k'))
  await page.waitForTimeout(300)

  expect(page.url()).not.toContain('rustdesk://')
  const status = await page.evaluate(() =>
    fetch('/admin/api/v1/auth/me', { credentials: 'same-origin' }).then((r) => r.status),
  )
  expect(status).toBe(200)
})
