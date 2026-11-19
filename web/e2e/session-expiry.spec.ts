// Review focus 1: the session ends mid-use. The next API call answers 401; the
// app goes to sign-in with the page as ?next=, without a loop or a raw error,
// and returns there after signing in.
import { expect, mockReady, test } from './support/test'

// Chromium logs every 401 response as a console error.
test.use({ allowConsoleErrors: [/status of 401/] })

test('a 401 mid-session goes to sign-in and back to the page', async ({ page }) => {
  await page.goto('/devices')
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
  await mockReady(page)

  const signIns: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && new URL(frame.url()).pathname === '/sign-in')
      signIns.push(frame.url())
  })

  // The session ends after five idle minutes, or is disabled by another admin. A device
  // changes, the live update refetches, and that call answers 401.
  await page.evaluate(() => {
    window.__ferricadeMock!.expireSession()
    window.__ferricadeMock!.approvePendingDevice()
  })

  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
  const url = new URL(page.url())
  expect(url.pathname).toBe('/sign-in')
  expect(url.searchParams.get('next')).toBe('/devices')
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.getByLabel('Username').fill('alex')
  await page.getByLabel('Password').fill('correct horse battery')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Two-factor code' })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('next')).toBe('/devices')
  await page.getByLabel('Code').fill('123456')
  await page.getByRole('button', { name: 'Verify' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/devices')
  // One trip to sign-in: no redirect loop.
  expect(signIns).toHaveLength(1)
})

test('the next navigation after session expiry goes to sign-in with its path', async ({ page }) => {
  await page.goto('/devices')
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
  await mockReady(page)
  await page.evaluate(() => window.__ferricadeMock!.expireSession())

  await page.getByRole('link', { name: 'Sessions' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
  const url = new URL(page.url())
  expect(url.pathname).toBe('/sign-in')
  expect(url.searchParams.get('next')).toBe('/sessions')
})
