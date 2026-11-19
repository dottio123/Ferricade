import { expect, test } from './support/test'

test.describe('Client Policies and group assignment', () => {
  test('owner creates a policy, assigns it to a group, sees child inherit, turns push on and off', async ({
    page,
  }) => {
    // 1. Navigate to Policies via sidebar
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Main' })
    await nav.getByRole('link', { name: 'Policies' }).click()

    await expect(page).toHaveURL(/\/policies/)
    await expect(page.getByRole('heading', { level: 1, name: 'Client Policies' })).toBeVisible()

    // 2. Check policy push card & default policy
    const pushSwitch = page.getByRole('switch', { name: 'Policy push' })
    await expect(pushSwitch).toBeVisible()
    await expect(pushSwitch).not.toBeChecked()

    // Check Default policy row
    await expect(page.getByRole('button', { name: 'Edit Default' })).toBeVisible()

    // 3. Create a new policy
    await page.getByRole('button', { name: 'New policy' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'New Client Policy' })).toBeVisible()

    const nameInput = page.getByLabel('Policy name')
    await nameInput.fill('Engineering Strict')

    // Find and manage a setting from the catalog, e.g. direct-server
    const directServerRow = page.locator('[data-slot="setting-row-direct-server"]')
    if (await directServerRow.isVisible()) {
      const combobox = directServerRow.getByRole('combobox')
      await combobox.click()
      await page.getByRole('option', { name: 'On' }).click()
    }

    // Submit the create form
    await page.getByRole('button', { name: 'Create policy' }).click()

    // Should return to policies list and display the new policy
    await expect(page.getByRole('heading', { level: 1, name: 'Client Policies' })).toBeVisible()
    await expect(page.getByText('Engineering Strict')).toBeVisible()

    // 4. Turn policy push ON
    await pushSwitch.click()
    const onDialog = page.getByRole('dialog')
    await expect(onDialog).toBeVisible()
    await expect(onDialog.getByRole('heading', { name: 'Turn on policy push?' })).toBeVisible()
    await expect(
      onDialog.getByText(
        "Approved devices apply their policy's settings within about 15 seconds. Managed settings override values set on the device or by a deployment script.",
      ),
    ).toBeVisible()

    await onDialog.getByRole('button', { name: 'Turn on', exact: true }).click()
    await expect(onDialog).not.toBeVisible()
    await expect(pushSwitch).toBeChecked()

    // 5. Turn policy push OFF
    await pushSwitch.click()
    const offDialog = page.getByRole('dialog')
    await expect(offDialog).toBeVisible()
    await expect(offDialog.getByRole('heading', { name: 'Turn off policy push?' })).toBeVisible()
    await expect(
      offDialog.getByText(
        'Devices keep the settings they last received. Ferricade stops managing them until you turn this on again.',
      ),
    ).toBeVisible()

    await offDialog.getByRole('button', { name: 'Turn off', exact: true }).click()
    await expect(offDialog).not.toBeVisible()
    await expect(pushSwitch).not.toBeChecked()

    // 6. Navigate to /groups and assign the policy to Office group
    await page.getByRole('link', { name: 'Groups' }).click()
    await expect(page).toHaveURL(/\/groups/)
    await expect(page.getByRole('heading', { level: 1, name: 'Groups' })).toBeVisible()

    // Assign Engineering Strict policy to Office group
    const officePicker = page.getByRole('combobox', { name: 'Policy for Office' })
    await expect(officePicker).toBeVisible()
    await officePicker.click()
    await page.getByRole('option', { name: 'Engineering Strict' }).click()

    // 7. Check that child group (Engineering) shows Inherited: Engineering Strict (from Office)
    const engineeringPicker = page.getByRole('combobox', { name: 'Policy for Engineering' })
    await expect(engineeringPicker).toBeVisible()
    await expect(engineeringPicker).toHaveText('Inherited: Engineering Strict (from Office)')
  })

  test('lockout confirmation buttons do not touch at the default viewport', async ({ page }) => {
    await page.goto('/policies')
    await page.getByRole('button', { name: 'New policy' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'New Client Policy' })).toBeVisible()

    await page.getByLabel('Policy name').fill('Footer Gap')
    await page.getByRole('combobox', { name: 'How incoming connections are accepted' }).click()
    await page.getByRole('option', { name: 'Click to accept only' }).click()
    await page.getByRole('button', { name: 'Create policy' }).click()

    const dialog = page.getByRole('dialog', { name: 'Confirm access baseline' })
    await expect(dialog).toBeVisible()
    const cancel = await dialog.getByRole('button', { name: 'Cancel' }).boundingBox()
    const save = await dialog.getByRole('button', { name: 'Save anyway' }).boundingBox()
    expect(cancel).not.toBeNull()
    expect(save).not.toBeNull()
    // At the default (desktop) width the footer is a row: Cancel sits left of Save anyway.
    expect(save!.x - (cancel!.x + cancel!.width)).toBeGreaterThanOrEqual(6)
  })
})
