import { expect, test } from './support/test'

test.describe('Command Center under large fleet', () => {
  test('renders all business modules without error and shows fleet group rows (?mock=large)', async ({
    page,
  }) => {
    // Navigate to dashboard with large mock dataset (400 devices)
    await page.goto('/?mock=large')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Verify all 8 default business modules render
    const expectedModules = [
      'fleet-pulse',
      'approval-queue',
      'needs-attention',
      'activity-trend',
      'live-sessions',
      'fleet-overview',
      'admin-activity',
      'platform-mix',
    ]

    for (const moduleId of expectedModules) {
      const moduleEl = page.locator(`[data-module-id="${moduleId}"]`)
      await expect(moduleEl).toBeVisible()

      // Once loaded (no skeleton left; a failing load retries for a few
      // seconds first), no module shows an error state of either kind.
      await expect(moduleEl.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 15_000 })
      await expect(moduleEl.locator('[data-slot$="error-state"]')).toHaveCount(0)
    }

    // The reworked overview keeps groups as rows even for a large fleet.
    const fleetOverviewModule = page.locator('[data-module-id="fleet-overview"]')
    await expect(fleetOverviewModule.locator('[data-slot="fleet-overview-body"]')).toBeVisible()
    expect(
      await fleetOverviewModule.locator('[data-slot="fleet-group-header"]').count(),
    ).toBeGreaterThan(0)
  })
})
