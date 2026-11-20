import { ROUTES } from './support/routes'
import { expect, mockReady, test } from './support/test'

const h1 = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('heading', { level: 1, name, exact: true })

test.describe('every route renders its page', () => {
  for (const route of ROUTES) {
    test(route.path, async ({ page }) => {
      let path = route.path
      if (route.id) {
        await page.goto('/devices')
        await mockReady(page)
        // The mock's ids are the same on every load (seeded fixtures).
        const id = await page.evaluate(() => window.__ferricadeMock!.approvedDeviceId())
        path = path.replace('$id', id)
      }
      await page.goto(route.query ? `${path}?${route.query}` : path)
      await expect(h1(page, route.heading)).toBeVisible()
      expect(new URL(page.url()).pathname).toBe(path)
    })
  }
})

test('every page redirects to /first-run while setup is open', async ({ page }) => {
  await page.goto('/devices?mock-setup=incomplete')
  await expect(h1(page, 'First-run setup')).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/first-run')
})

test('/first-run redirects to the command center once setup is done', async ({ page }) => {
  await page.goto('/first-run')
  await expect(h1(page, 'Command Center')).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/')
})

test('an unknown path shows "Page not found"', async ({ page }) => {
  await page.goto('/no/such/page')
  await expect(h1(page, 'Page not found')).toBeVisible()
})

test('every page h1 has the Headline size (24px, 700 weight)', async ({ page }) => {
  for (const route of ROUTES) {
    let path = route.path
    if (route.id) {
      await page.goto('/devices')
      await mockReady(page)
      const id = await page.evaluate(() => window.__ferricadeMock!.approvedDeviceId())
      path = path.replace('$id', id)
    }
    await page.goto(route.query ? `${path}?${route.query}` : path)
    const heading = page.getByRole('heading', { level: 1, name: route.heading, exact: true })
    await expect(heading).toBeVisible()
    const styles = await heading.evaluate((el) => {
      const computed = window.getComputedStyle(el)
      return {
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
      }
    })
    expect(styles.fontSize, `h1 on ${route.path} fontSize`).toBe('24px')
    expect(styles.fontWeight, `h1 on ${route.path} fontWeight`).toBe('700')
  }
})

test('an admin is told that only owners can manage users', async ({ page }) => {
  await page.goto('/settings/users?mock-role=admin')
  await expect(page.getByText('Only owners can manage users.')).toBeVisible()
  await expect(h1(page, 'Users')).toHaveCount(0)
})
