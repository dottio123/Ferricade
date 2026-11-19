import { expect, test } from './support/test'

test.describe('/settings/users access', () => {
  test('/settings/users is reachable by owner and not listed for an admin (?mock-role=admin)', async ({
    page,
  }) => {
    // Owner sees users page and settings card
    await page.goto('/settings')
    await expect(page.getByRole('link', { name: /Users/i })).toBeVisible()
    await page.goto('/settings/users')
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible()

    // Admin does NOT see Users card on /settings and is blocked on /settings/users
    await page.goto('/settings?mock-role=admin')
    await expect(page.getByRole('link', { name: /Users/i })).toHaveCount(0)
    await page.goto('/settings/users?mock-role=admin')
    await expect(page.getByText('Only owners can manage users.')).toBeVisible()
  })
})
