import { expect, test } from './support/test'

test.use({ allowConsoleErrors: [/status of 409 \(Conflict\)/] })

test.describe('Tags page & features', () => {
  test('loads tags page with heading and tags table', async ({ page }) => {
    await page.goto('/tags')
    await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible()

    // Seed tags from medium mock: server, laptop, kiosk, etc.
    await expect(page.getByText('server')).toBeVisible()
    await expect(page.getByText('laptop')).toBeVisible()
  })

  test('creates a tag with a color, recolors it, and deletes it with confirmation', async ({
    page,
  }) => {
    await page.goto('/tags')

    // 1. Create a tag with a color
    await page.getByRole('button', { name: 'New tag' }).click()
    await expect(page.getByRole('heading', { name: 'Create new tag' })).toBeVisible()

    await page.getByLabel('Tag name').fill('staging-qa')

    // Click green swatch
    await page.getByRole('button', { name: 'Green' }).click()
    await expect(page.getByLabel('Hex color')).toHaveValue('#4caf50')

    await page.getByRole('button', { name: 'Create tag' }).click()

    // Assert tag is created and visible in list
    const tagRow = page.locator('[data-slot="tag-row"]', { hasText: 'staging-qa' })
    await expect(tagRow).toBeVisible()
    await expect(
      tagRow.getByText('#4caf50', { exact: false }).filter({ visible: true }),
    ).toBeVisible()

    // 2. Recolor the tag via Edit dialog
    await tagRow.getByRole('button', { name: 'Edit' }).click()
    await expect(page.getByRole('heading', { name: 'Edit tag' })).toBeVisible()

    // Change color using hex input
    const hexInput = page.getByLabel('Hex color')
    await hexInput.fill('#ff9800') // Orange
    await page.getByRole('button', { name: 'Save changes' }).click()

    await expect(
      tagRow.getByText('#ff9800', { exact: false }).filter({ visible: true }),
    ).toBeVisible()

    // 3. Delete the tag with confirmation
    await tagRow.getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByRole('heading', { name: 'Delete tag' })).toBeVisible()
    await expect(
      page.getByText('This tag will be removed from every device that has it.'),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Delete tag' }).click()

    // Assert tag is removed
    await expect(page.getByText('staging-qa')).toHaveCount(0)
  })

  test('shows calm error when creating duplicate tag name', async ({ page }) => {
    await page.goto('/tags')

    // 'server' is an existing seed tag
    await page.getByRole('button', { name: 'New tag' }).click()
    await page.getByLabel('Tag name').fill('server')
    await page.getByRole('button', { name: 'Create tag' }).click()

    await expect(page.getByText('A tag with this name already exists.')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
  })
})
