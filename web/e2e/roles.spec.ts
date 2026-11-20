import { expect, test } from './support/test'

test.describe('Role-based access controls (?mock-role=admin)', () => {
  test('restricts /settings/users to owners and hides Users from sidebar', async ({ page }) => {
    // Navigate with ?mock-role=admin
    await page.goto('/settings/users?mock-role=admin')

    // OwnerOnly banner/message is shown
    await expect(page.getByText('Only owners can manage users.')).toBeVisible()

    // Users table and create button should not exist
    await expect(page.getByRole('button', { name: 'New user' })).toHaveCount(0)
    await expect(page.getByRole('table')).toHaveCount(0)

    // Sidebar navigation should not include Users link
    const sidebar = page.locator('aside')
    await expect(sidebar.getByRole('link', { name: 'Users' })).toHaveCount(0)
  })

  test('restricts server settings editing to owners while allowing reachability checks', async ({
    page,
  }) => {
    await page.goto('/settings/server?mock-role=admin')
    await expect(page.getByRole('heading', { level: 1, name: 'Server' })).toBeVisible()

    // Read-only banner is displayed
    await expect(
      page.getByText(
        /Only owners can edit server settings\. Values are displayed in read-only mode\./i,
      ),
    ).toBeVisible()

    // Form inputs are disabled
    await expect(page.getByLabel('ID server host')).toBeDisabled()
    await expect(page.getByLabel('Relay server host')).toBeDisabled()
    await expect(page.getByLabel('Public key')).toBeDisabled()

    // Save changes button is not shown for admin
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0)

    // Run checks button is still available and functional for admin
    const runChecksBtn = page.getByRole('button', { name: 'Run checks' })
    await expect(runChecksBtn).toBeVisible()
    await runChecksBtn.click()

    await expect(page.getByText('Reachability check results:')).toBeVisible()
  })

  test('restricts Fleet Thresholds editing to owners while allowing layout presets', async ({
    page,
  }) => {
    // 1. Fleet Thresholds on /settings/thresholds
    await page.goto('/settings/thresholds?mock-role=admin')
    await expect(page.getByRole('heading', { level: 1, name: 'Fleet Thresholds' })).toBeVisible()

    // Read-only banner is displayed
    await expect(
      page.getByText(
        /Only owners can edit fleet thresholds\. Values are displayed in read-only mode\./i,
      ),
    ).toBeVisible()

    // Threshold inputs are disabled
    await expect(page.getByLabel('Offline attention threshold (days)')).toBeDisabled()
    await expect(page.getByLabel('Pending attention threshold (hours)')).toBeDisabled()
    await expect(page.getByLabel('Minimum RustDesk client version')).toBeDisabled()

    // Save thresholds button is not shown
    await expect(page.getByRole('button', { name: 'Save thresholds' })).toHaveCount(0)

    // 2. Layout presets on /account/dashboard
    await page.goto('/account/dashboard?mock-role=admin')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard Layout' })).toBeVisible()

    // Layout presets are still available and can be applied
    const applyHomelabBtn = page.getByRole('button', { name: 'Apply Homelab' })
    await expect(applyHomelabBtn).toBeVisible()
    await applyHomelabBtn.click()

    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: 'Applied homelab preset' }),
    ).toBeVisible()
  })
})
