import { expect, test } from './support/test'

test.describe('Device actions: delete, star pin, and uuid sizing', () => {
  // On /audit after a delete, earlier entries about the deleted device (enrolled,
  // approved) still look it up by ID to show its name, and get 404.
  test.use({ allowConsoleErrors: [/404 \(Not Found\) .*\/admin\/api\/v1\/devices\//] })

  test('Item 1: delete approved device flow (cancel, confirm, toast, row removed, audit recorded)', async ({
    page,
  }) => {
    await page.goto('/devices?state=approved')
    await expect(page.locator('[data-slot="devices-table"]')).toBeVisible()

    // Find an approved device row
    const row = page.locator('tbody tr[data-device-id]').first()
    await expect(row).toBeVisible()
    const deviceId = await row.getAttribute('data-device-id')
    expect(deviceId).toBeTruthy()
    const name = (await row.locator('[data-slot="device-link"]').first().textContent())?.trim()
    expect(name).toBeTruthy()

    // Open panel
    await row.locator('[data-slot="device-link"]').first().click()
    const panel = page.locator('[data-slot="device-detail"]')
    await expect(panel).toBeVisible()

    // Click Delete
    await panel.getByRole('button', { name: 'Delete', exact: true }).click()

    // Dialog appears
    const dialog = page.locator('[data-slot="device-delete-dialog"]')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: `Delete ${name}?` })).toBeVisible()
    await expect(dialog.getByText('This removes the device')).toBeVisible()

    // Cancel leaves device in place
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible()
    await expect(panel).toBeVisible()
    await expect(page.locator(`tbody tr[data-device-id="${deviceId}"]`)).toBeVisible()

    // Open Delete again and confirm
    await panel.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete device' }).click()

    // Toast shows
    await expect(page.getByText('Device deleted', { exact: true })).toBeVisible()

    // Panel closes
    await expect(panel).not.toBeVisible()

    // Row is removed without reload
    await expect(page.locator(`tbody tr[data-device-id="${deviceId}"]`)).not.toBeVisible()

    // Navigate to /audit via client routing so in-memory mock db audit log is preserved
    await page.getByRole('link', { name: 'Audit Log' }).click()
    await expect(page).toHaveURL('/audit')
    await expect(page.locator('[data-slot="audit-timeline"]')).toBeVisible()
    const deleted = page.locator('[data-slot="audit-event-item"][data-action="device.deleted"]')
    await expect(deleted.getByText(`deleted ${name}`)).toBeVisible()
    // The device is gone: the entry names it but does not link to it.
    await expect(deleted.locator('[data-slot="device-link"]')).toHaveCount(0)
  })

  test('Item 1: delete pending device from /devices', async ({ page }) => {
    await page.goto('/devices?state=pending')
    await expect(page.locator('[data-slot="devices-table"]')).toBeVisible()

    const row = page.locator('tbody tr[data-device-id]').first()
    await expect(row).toBeVisible()
    const deviceId = await row.getAttribute('data-device-id')
    expect(deviceId).toBeTruthy()
    const name = (await row.locator('[data-slot="device-link"]').first().textContent())?.trim()
    expect(name).toBeTruthy()

    // Open panel
    await row.locator('[data-slot="device-link"]').first().click()
    const panel = page.locator('[data-slot="device-detail"]')
    await expect(panel).toBeVisible()

    // Click Delete
    await panel.getByRole('button', { name: 'Delete', exact: true }).click()

    const dialog = page.locator('[data-slot="device-delete-dialog"]')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: `Delete ${name}?` })).toBeVisible()

    // Confirm
    await dialog.getByRole('button', { name: 'Delete device' }).click()

    // Toast shows and panel closes
    await expect(page.getByText('Device deleted', { exact: true })).toBeVisible()
    await expect(panel).not.toBeVisible()

    // Row is removed without reload
    await expect(page.locator(`tbody tr[data-device-id="${deviceId}"]`)).not.toBeVisible()

    // Navigate to /audit via client routing so in-memory mock db audit log is preserved
    await page.getByRole('link', { name: 'Audit Log' }).click()
    await expect(page).toHaveURL('/audit')
    await expect(page.locator('[data-slot="audit-timeline"]')).toBeVisible()
    const deleted = page.locator('[data-slot="audit-event-item"][data-action="device.deleted"]')
    await expect(deleted.getByText(`deleted ${name}`)).toBeVisible()
    // The device is gone: the entry names it but does not link to it.
    await expect(deleted.locator('[data-slot="device-link"]')).toHaveCount(0)
  })

  test('Item 2: star button in devices table toggles, persists after reload, reflects in panel, and does not open panel', async ({
    page,
  }) => {
    await page.goto('/devices')
    await expect(page.locator('[data-slot="devices-table"]')).toBeVisible()

    const row = page.locator('tbody tr[data-device-id]').first()
    await expect(row).toBeVisible()
    const deviceId = await row.getAttribute('data-device-id')
    const starBtn = row.getByRole('button', { name: /^(Pin|Unpin) / })
    await expect(starBtn).toBeVisible()

    const initialPressed = await starBtn.getAttribute('aria-pressed')
    const targetPressed = initialPressed === 'true' ? 'false' : 'true'

    // Click star button - does NOT open panel
    await starBtn.click()
    await expect(starBtn).toHaveAttribute('aria-pressed', targetPressed)
    await expect(page.locator('[data-slot="device-detail"]')).not.toBeVisible()
    expect(page.url()).not.toContain('device=')

    // Persists across reload
    await page.reload()
    await expect(page.locator('[data-slot="devices-table"]')).toBeVisible()
    const reloadedRow = page.locator(`tbody tr[data-device-id="${deviceId}"]`)
    const reloadedStar = reloadedRow.getByRole('button', { name: /^(Pin|Unpin) / })
    await expect(reloadedStar).toHaveAttribute('aria-pressed', targetPressed)

    // Open device panel - reflects same pin state
    await reloadedRow.locator('[data-slot="device-link"]').first().click()
    const panel = page.locator('[data-slot="device-detail"]')
    await expect(panel).toBeVisible()

    const panelPinBtn = panel.getByRole('button', {
      name: targetPressed === 'true' ? 'Unpin device' : 'Pin device',
    })
    await expect(panelPinBtn).toBeVisible()
  })

  test('Item 3: uuid stays inside its grid cell at 1280px and 390px', async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/devices')
      await page.locator('[data-slot="device-link"]').first().click()
      await expect(page.locator('[data-slot="device-detail"]')).toBeVisible()

      // Find the cell containing the Pinned Client UUID
      const uuidLabel = page.getByText('Pinned Client UUID', { exact: true })
      const cell = uuidLabel.locator('..')
      await expect(cell).toBeVisible()

      const monoId = cell.locator('[data-slot="mono-id"]')
      await expect(monoId).toBeVisible()

      // Verify that UUID text is truncated (has ellipsis and short length)
      const monoText = await monoId.textContent()
      expect(monoText).toContain('…')
      expect(monoText!.length).toBeLessThan(20)

      const cellBox = await cell.boundingBox()
      const monoBox = await monoId.boundingBox()
      expect(cellBox).not.toBeNull()
      expect(monoBox).not.toBeNull()

      // UUID element must not extend beyond the cell's right boundary
      expect(
        monoBox!.x + monoBox!.width,
        `UUID right edge (${(monoBox!.x + monoBox!.width).toFixed(1)}) exceeds cell right edge (${(cellBox!.x + cellBox!.width).toFixed(1)}) at ${width}px`,
      ).toBeLessThanOrEqual(cellBox!.x + cellBox!.width + 1)
    }
  })
})
