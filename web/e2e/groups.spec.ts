import { expect, test } from './support/test'

test.use({ allowConsoleErrors: [/status of 409 \(Conflict\)/] })

test.describe('Groups page & features', () => {
  test('Ungrouped devices link opens the filtered device list', async ({ page }) => {
    await page.goto('/groups')
    const link = page.getByRole('link', { name: /ungrouped devices/i })
    await expect(link).toHaveAttribute('href', '/devices?group=ungrouped')
    await link.click()
    await expect(page).toHaveURL('/devices?group=ungrouped')
    await expect(page.getByRole('button', { name: 'Remove Ungrouped filter' })).toBeVisible()
  })

  test('loads groups page with heading and tree nodes', async ({ page }) => {
    await page.goto('/groups')
    await expect(page.getByRole('heading', { level: 1, name: 'Groups' })).toBeVisible()

    // Assert some seed groups from the medium fixture are visible
    await expect(page.getByText('Office')).toBeVisible()
    await expect(page.getByText('Home lab')).toBeVisible()
  })

  test('creates a root group and a subgroup', async ({ page }) => {
    await page.goto('/groups')

    // 1. Create a root group
    await page.getByRole('button', { name: 'New group' }).click()
    await expect(page.getByRole('heading', { name: 'Create new group' })).toBeVisible()
    await page.getByLabel('Group name').fill('New Test Root')
    await page.getByRole('button', { name: 'Create group' }).click()

    await expect(page.getByText('New Test Root')).toBeVisible()

    // 2. Add subgroup under the newly created root
    const rootNode = page.locator('[data-slot="group-node"]', { hasText: 'New Test Root' })
    await rootNode.getByRole('button', { name: /Actions for group New Test Root/i }).click()
    await page.getByRole('menuitem', { name: 'Add subgroup' }).click()

    await expect(
      page.getByRole('heading', { name: /Add subgroup under "New Test Root"/i }),
    ).toBeVisible()
    await page.getByLabel('Group name').fill('Test Subgroup')
    await page.getByRole('button', { name: 'Create group' }).click()

    await expect(page.getByText('Test Subgroup')).toBeVisible()
  })

  test('renames a group', async ({ page }) => {
    await page.goto('/groups')

    // Create a group to rename
    await page.getByRole('button', { name: 'New group' }).click()
    await page.getByLabel('Group name').fill('Group To Rename')
    await page.getByRole('button', { name: 'Create group' }).click()
    await expect(page.getByText('Group To Rename')).toBeVisible()

    // Open rename dialog
    const groupNode = page.locator('[data-slot="group-node"]', { hasText: 'Group To Rename' })
    await groupNode.getByRole('button', { name: /Actions for group Group To Rename/i }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()

    await expect(page.getByRole('heading', { name: 'Rename group' })).toBeVisible()
    const nameInput = page.getByLabel('Group name')
    await nameInput.fill('Renamed Group Final')
    await page.getByRole('button', { name: 'Rename' }).click()

    await expect(page.getByText('Renamed Group Final')).toBeVisible()
    await expect(page.getByText('Group To Rename')).toHaveCount(0)
  })

  test('moves a group and verifies descendants are not offered in Move to dialog', async ({
    page,
  }) => {
    await page.goto('/groups')

    // 'Office' has children ('Reception', 'Engineering')
    const officeNode = page.locator('[data-slot="group-node"]', { hasText: 'Office' }).first()
    await officeNode.getByRole('button', { name: /Actions for group Office/i }).click()
    await page.getByRole('menuitem', { name: 'Move to…' }).click()

    await expect(page.getByRole('heading', { name: 'Move group' })).toBeVisible()

    // Open select dropdown
    await page.getByRole('combobox').click()

    // In the dropdown, 'Office', 'Reception', and 'Engineering' MUST NOT be options
    // Only 'Top level', 'Home lab', 'Remote staff' should be selectable
    await expect(page.getByRole('option', { name: /Top level/i })).toBeVisible()
    await expect(page.getByRole('option', { name: /Home lab/i })).toBeVisible()
    await expect(page.getByRole('option', { name: /Office/i })).toHaveCount(0)
    await expect(page.getByRole('option', { name: /Reception/i })).toHaveCount(0)
    await expect(page.getByRole('option', { name: /Engineering/i })).toHaveCount(0)

    // Close select without submitting
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('not_empty error is shown when trying to delete group with subgroups or devices', async ({
    page,
  }) => {
    await page.goto('/groups')

    // 'Office' is not empty (it has subgroups 'Reception' and 'Engineering')
    const officeNode = page.locator('[data-slot="group-node"]', { hasText: 'Office' }).first()
    await officeNode.getByRole('button', { name: /Actions for group Office/i }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()

    await expect(page.getByRole('heading', { name: 'Delete group' })).toBeVisible()
    await page.getByRole('button', { name: 'Delete' }).click()

    // Expect calm mapped error
    await expect(
      page.getByText('This group still has subgroups or devices. Move them out first.'),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('deletes an empty group with confirmation', async ({ page }) => {
    await page.goto('/groups')

    // Create an empty group
    await page.getByRole('button', { name: 'New group' }).click()
    await page.getByLabel('Group name').fill('Group For Deletion')
    await page.getByRole('button', { name: 'Create group' }).click()
    await expect(page.getByText('Group For Deletion')).toBeVisible()

    // Delete it
    const groupNode = page.locator('[data-slot="group-node"]', { hasText: 'Group For Deletion' })
    await groupNode.getByRole('button', { name: /Actions for group Group For Deletion/i }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()

    await expect(page.getByRole('heading', { name: 'Delete group' })).toBeVisible()
    await page.getByRole('button', { name: 'Delete' }).click()

    // Assert it is gone
    await expect(page.getByText('Group For Deletion')).toHaveCount(0)
  })
})
