import { expect, test } from './support/test'

test.describe('Command Center & dashboard features', () => {
  test('loads default business layout with heading and modules', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const grid = page.locator('[data-slot="dashboard-grid"]')
    await expect(grid).toBeVisible()

    // Default business preset modules should be visible
    await expect(page.locator('[data-module-id="fleet-pulse"]')).toBeVisible()
    await expect(page.locator('[data-module-id="approval-queue"]')).toBeVisible()
    await expect(page.locator('[data-module-id="needs-attention"]')).toBeVisible()
    await expect(page.locator('[data-module-id="activity-trend"]')).toBeVisible()
    await expect(page.locator('[data-module-id="live-sessions"]')).toBeVisible()
    await expect(page.locator('[data-module-id="fleet-overview"]')).toBeVisible()
    await expect(page.locator('[data-module-id="admin-activity"]')).toBeVisible()
    await expect(page.locator('[data-module-id="platform-mix"]')).toBeVisible()
  })

  test('switches between presets (Homelab, Monitoring wall, Business)', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // 1. Switch to Homelab preset
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await expect(drawer).toBeVisible()

    await drawer.getByRole('button', { name: 'Homelab' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
    await expect(drawer).toBeHidden()
    await expect(page.locator('[data-slot="toast-title"]').getByText('Layout saved')).toBeVisible()

    // Homelab includes quick-connect and recent-sessions, but excludes admin-activity
    await expect(page.locator('[data-module-id="quick-connect"]')).toBeVisible()
    await expect(page.locator('[data-module-id="recent-sessions"]')).toBeVisible()
    await expect(page.locator('[data-module-id="admin-activity"]')).toBeHidden()

    // Verify catalog dimensions for homelab preset modules
    await expect(page.locator('[data-module-id="fleet-pulse"]')).toHaveAttribute('data-cols', '4')
    await expect(page.locator('[data-module-id="fleet-pulse"]')).toHaveAttribute('data-rows', '1')
    await expect(page.locator('[data-module-id="quick-connect"]')).toHaveAttribute('data-cols', '2')
    await expect(page.locator('[data-module-id="quick-connect"]')).toHaveAttribute('data-rows', '2')

    // 2. Switch to Wall preset ("Monitoring wall")
    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'Monitoring wall' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
    await expect(drawer).toBeHidden()

    // In Wall preset:
    // - "Customize" button is hidden
    // - "Change layout" button is visible
    // - grid has wall-preset class
    await expect(page.getByRole('button', { name: 'Customize' })).toBeHidden()
    const changeLayoutButton = page.getByRole('button', { name: 'Change layout' })
    await expect(changeLayoutButton).toBeVisible()
    await expect(page.locator('[data-slot="dashboard-grid"]')).toHaveAttribute(
      'data-preset',
      'wall',
    )

    // Verify catalog dimensions for wall preset modules
    await expect(page.locator('[data-module-id="fleet-pulse"]')).toHaveAttribute('data-cols', '4')
    // Fleet pulse has no large size (no graphs): the wall shows it at medium, 4x1.
    await expect(page.locator('[data-module-id="fleet-pulse"]')).toHaveAttribute('data-rows', '1')
    await expect(page.locator('[data-module-id="live-sessions"]')).toHaveAttribute('data-cols', '2')
    await expect(page.locator('[data-module-id="live-sessions"]')).toHaveAttribute('data-rows', '2')

    // 3. Switch back to Business preset via "Change layout"
    await changeLayoutButton.click()
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'Business' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
    await expect(drawer).toBeHidden()

    // In Business preset: Customize button is back and catalog dimensions match
    await expect(page.getByRole('button', { name: 'Customize' })).toBeVisible()
    await expect(page.locator('[data-module-id="admin-activity"]')).toBeVisible()
    await expect(page.locator('[data-module-id="fleet-pulse"]')).toHaveAttribute('data-cols', '4')
    await expect(page.locator('[data-module-id="fleet-pulse"]')).toHaveAttribute('data-rows', '1')
    await expect(page.locator('[data-module-id="approval-queue"]')).toHaveAttribute(
      'data-cols',
      '2',
    )
    await expect(page.locator('[data-module-id="approval-queue"]')).toHaveAttribute(
      'data-rows',
      '2',
    )
    await expect(page.locator('[data-module-id="activity-trend"]')).toHaveAttribute(
      'data-cols',
      '4',
    )
    await expect(page.locator('[data-module-id="activity-trend"]')).toHaveAttribute(
      'data-rows',
      '2',
    )
  })

  test('toggles a module off and persists across page reload', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await expect(page.locator('[data-module-id="admin-activity"]')).toBeVisible()

    // Open Customize drawer
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await expect(drawer).toBeVisible()

    // Toggle admin-activity off
    const toggle = drawer.getByRole('switch', { name: 'Show Admin activity' })
    await toggle.click()

    // Save
    await drawer.getByRole('button', { name: 'Save layout' }).click()
    await expect(page.locator('[data-slot="toast-title"]').getByText('Layout saved')).toBeVisible()

    // Module should be hidden
    await expect(page.locator('[data-module-id="admin-activity"]')).toBeHidden()

    // Reload page to verify persistence
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await expect(page.locator('[data-module-id="admin-activity"]')).toBeHidden()

    // Clean up / restore by resetting to default
    await page.getByRole('button', { name: 'Customize' }).click()
    await drawer.getByRole('button', { name: 'Reset to default' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
    await expect(page.locator('[data-module-id="admin-activity"]')).toBeVisible()
  })

  test('reorders modules in edit mode and persists across page reload', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Initial first module should be fleet-pulse
    const grid = page.locator('[data-slot="dashboard-grid"]')
    const firstModuleBefore = grid.locator('> div').first()
    await expect(firstModuleBefore).toHaveAttribute('data-module-id', 'fleet-pulse')

    // Click Customize to enter edit mode
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await expect(drawer).toBeVisible()
    // Close the drawer so we can interact with the in-grid sortable cards
    await drawer.getByRole('button', { name: 'Close' }).click()
    await expect(drawer).toBeHidden()

    // Move second module (needs-attention) up
    const moveUpButton = page.getByRole('button', { name: 'Move needs-attention up' })
    await expect(moveUpButton).toBeVisible()
    await moveUpButton.click()

    // Now needs-attention should be the first module in the staged DOM
    const firstModuleStaged = grid.locator('> div').first()
    await expect(firstModuleStaged).toHaveAttribute('data-module-id', 'needs-attention')

    // Click "Save layout" in top action bar
    await page.getByRole('button', { name: 'Save layout' }).click()
    await expect(page.locator('[data-slot="toast-title"]').getByText('Layout saved')).toBeVisible()

    // Reload page to verify reorder persistence
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const firstModuleAfterReload = grid.locator('> div').first()
    await expect(firstModuleAfterReload).toHaveAttribute('data-module-id', 'needs-attention')

    // Reset back to default
    await page.getByRole('button', { name: 'Customize' }).click()
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'Reset to default' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
    await expect(grid.locator('> div').first()).toHaveAttribute('data-module-id', 'fleet-pulse')
  })

  test('undo toast restores previous layout', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await expect(page.locator('[data-module-id="platform-mix"]')).toBeVisible()

    // Open Customize and toggle off platform-mix
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await expect(drawer).toBeVisible()

    await drawer.getByRole('switch', { name: 'Show Platform mix' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()

    // Verify toast with Undo action
    const toast = page.locator('[data-slot="toast-title"]').getByText('Layout saved')
    await expect(toast).toBeVisible()
    await expect(page.locator('[data-module-id="platform-mix"]')).toBeHidden()

    // Click Undo
    const undoButton = page.getByRole('button', { name: 'Undo' })
    await expect(undoButton).toBeVisible()
    await undoButton.click()

    // Toast confirms restore and module reappears
    await expect(
      page.locator('[data-slot="toast-title"]').getByText('Layout restored'),
    ).toBeVisible()
    await expect(page.locator('[data-module-id="platform-mix"]')).toBeVisible()
  })

  test('connect from quick-connect generates rustdesk:// link', async ({ page }) => {
    // Pin an approved device so quick-connect is guaranteed to show it
    await page.goto('/devices?state=approved')
    await page.locator('[data-slot="devices-table"] tbody tr a').first().click()
    const detailPanel = page.locator('[data-slot="device-detail"]')
    await expect(detailPanel).toBeVisible()
    // Wait for the pin control in either state, then pin if it is not yet.
    const pinToggle = detailPanel.getByRole('button', { name: /^(Pin|Unpin) device$/ })
    await expect(pinToggle).toBeVisible()
    if ((await pinToggle.getAttribute('aria-label')) === 'Pin device') await pinToggle.click()
    await expect(detailPanel.getByRole('button', { name: 'Unpin device' })).toBeVisible()

    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Quick connect is not on the default layout: turn it on.
    const quickConnect = page.locator('[data-module-id="quick-connect"]')
    await expect(page.locator('[data-module-id="fleet-pulse"]')).toBeVisible()
    await expect(quickConnect).toHaveCount(0)
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await drawer.getByRole('switch', { name: 'Show Quick connect' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
    await expect(quickConnect).toBeVisible()

    // Locate a Connect button in quick-connect
    const connectButton = quickConnect.getByRole('button', { name: /Connect to / }).first()
    await expect(connectButton).toBeVisible()
    await connectButton.click()

    // Assert Open in RustDesk link appears with rustdesk:// URL
    const openLink = quickConnect.getByRole('link', { name: 'Open in RustDesk' })
    await expect(openLink).toBeVisible()
    await expect(openLink).toHaveAttribute('href', /^rustdesk:\/\/\d+@[^?]+\?key=/)
  })

  test('approves device directly from approval-queue module', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const queueModule = page.locator('[data-module-id="approval-queue"]')
    await expect(queueModule).toBeVisible()

    const queueItems = queueModule.locator('[data-slot="queue-item"]')
    await expect(queueItems.first()).toBeVisible()

    const approvedDeviceName = (
      await queueItems.first().locator('[data-slot="device-link"]').textContent()
    )?.trim()
    const approveButton = queueItems.first().getByRole('button', { name: /Approve / })
    await approveButton.click()

    // Toast notification confirms approval
    await expect(
      page.locator('[data-slot="toast-title"]').getByText('Device approved', { exact: true }),
    ).toBeVisible()

    // The approved device is removed from the queue
    expect(approvedDeviceName).toBeTruthy()
    await expect(
      queueModule.locator('[data-slot="queue-item"]', { hasText: approvedDeviceName }),
    ).toHaveCount(0)
  })

  test('pins and unpins devices between device details and quick connect', async ({ page }) => {
    // 1. Navigate to approved devices list
    await page.goto('/devices?state=approved')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

    // Open detail panel for the first device
    const firstRowLink = page.locator('[data-slot="devices-table"] tbody tr a').first()
    await expect(firstRowLink).toBeVisible()
    const deviceName = (await firstRowLink.textContent())?.trim() ?? 'Device'
    await firstRowLink.click()

    const detailPanel = page.locator('[data-slot="device-detail"]')
    await expect(detailPanel).toBeVisible()

    // Locate star pin button
    // Wait for the pin control in either state, then pin if it is not yet.
    const pinToggle = detailPanel.getByRole('button', { name: /^(Pin|Unpin) device$/ })
    await expect(pinToggle).toBeVisible()
    if ((await pinToggle.getAttribute('aria-label')) === 'Pin device') await pinToggle.click()
    await expect(detailPanel.getByRole('button', { name: 'Unpin device' })).toBeVisible()

    // 2. Navigate back to Command Center
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Quick connect is not on the default layout: turn it on.
    const quickConnect = page.locator('[data-module-id="quick-connect"]')
    await expect(page.locator('[data-module-id="fleet-pulse"]')).toBeVisible()
    await expect(quickConnect).toHaveCount(0)
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await drawer.getByRole('switch', { name: 'Show Quick connect' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
    await expect(quickConnect).toBeVisible()

    // Pinned device should appear with "Pinned" text
    const pinnedItem = quickConnect.locator('[data-slot="quick-connect-item"]', {
      hasText: deviceName,
    })
    await expect(pinnedItem).toBeVisible()
    await expect(pinnedItem).toContainText('Pinned')

    // 3. Unpin directly from quick-connect
    const unpinButton = pinnedItem.getByRole('button', { name: new RegExp(`Unpin ${deviceName}`) })
    await unpinButton.click()

    // Device is either removed or changes to Recent
    await expect(pinnedItem.locator('text=Pinned')).toHaveCount(0)
  })

  test('persists module size changes across reload with correct grid spans', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Enter edit mode
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'Close' }).click()
    await expect(drawer).toBeHidden()

    // approval-queue is medium (cols: 2, rows: 2) by default
    const queueModule = page.locator('[data-module-id="approval-queue"]')
    await expect(queueModule).toHaveAttribute('data-cols', '2')
    await expect(queueModule).toHaveAttribute('data-rows', '2')

    // Change size to large via size picker on card
    const sizePicker = page.getByRole('group', { name: 'Size for approval-queue' })
    await sizePicker.getByRole('button', { name: 'large size' }).click()

    // Large list module has cols: 2, rows: 3
    await expect(queueModule).toHaveAttribute('data-cols', '2')
    await expect(queueModule).toHaveAttribute('data-rows', '3')

    // Save layout
    await page.getByRole('button', { name: 'Save layout' }).click()
    await expect(page.locator('[data-slot="toast-title"]').getByText('Layout saved')).toBeVisible()

    // Reload page to verify persistence
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const reloadedQueue = page.locator('[data-module-id="approval-queue"]')
    await expect(reloadedQueue).toHaveAttribute('data-cols', '2')
    await expect(reloadedQueue).toHaveAttribute('data-rows', '3')

    // Restore back to default
    await page.getByRole('button', { name: 'Customize' }).click()
    await drawer.getByRole('button', { name: 'Reset to default' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
  })

  test('drag transform contains no scale factor during module drag', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Enter edit mode
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'Close' }).click()
    await expect(drawer).toBeHidden()

    const dragHandle = page.getByRole('button', { name: 'Drag to reorder fleet-pulse' })
    await expect(dragHandle).toBeVisible()

    const box = await dragHandle.boundingBox()
    expect(box).not.toBeNull()

    // Start mouse drag
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2 + 30, box!.y + box!.height / 2 + 40, { steps: 5 })

    // Check style on fleet-pulse sortable card
    const styleAttr = await page.locator('[data-module-id="fleet-pulse"]').getAttribute('style')
    expect(styleAttr).not.toBeNull()
    expect(styleAttr).not.toContain('scale')

    await page.mouse.up()
  })

  test('approval queue badge matches pending count from stats summary', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const summaryData = await page.evaluate(async () => {
      const res = await fetch('/admin/api/v1/stats/summary')
      return (await res.json()) as { devices: { pending: number } }
    })
    const expectedPending = summaryData.devices.pending

    const queueModule = page.locator('[data-module-id="approval-queue"]')
    // The medium mock always has pending devices.
    expect(expectedPending).toBeGreaterThan(0)
    await expect(queueModule.locator('[data-slot="badge"]')).toHaveText(String(expectedPending))
  })

  test('fleet pulse shows numbers and their 24 h change, without graphs', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const fleetPulse = page.locator('[data-module-id="fleet-pulse"]')
    await expect(fleetPulse).toBeVisible()
    // The user asked for the sparklines to go; the change lines stay.
    await expect(fleetPulse.locator('svg[role="img"]')).toHaveCount(0)
    await expect(fleetPulse.getByText(/vs 24 h ago|no change/).first()).toBeVisible()
  })

  test('fleet pulse fits its tablet card without overlapping the next module', async ({ page }) => {
    for (const [width, height] of [
      [768, 1024],
      [820, 1180],
    ] as const) {
      await page.setViewportSize({ width, height })
      await page.goto('/?mock=large')
      const pulse = page.locator('[data-module-id="fleet-pulse"]')
      await expect(pulse.locator('[data-slot="pulse-number"]').first()).toBeVisible()
      const metrics = await pulse.evaluate((el) => {
        const card = el.querySelector<HTMLElement>('[data-slot="dashboard-module-card"]')!
        const bounds = card.getBoundingClientRect()
        const tiles = [...card.querySelectorAll('[data-slot="fleet-pulse-tile"]')]
        const next = el.nextElementSibling!.getBoundingClientRect()
        return {
          clientHeight: card.clientHeight,
          scrollHeight: card.scrollHeight,
          bottom: Math.max(...tiles.map((tile) => tile.getBoundingClientRect().bottom)),
          cardBottom: bounds.bottom,
          nextTop: next.top,
        }
      })
      expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight)
      expect(metrics.bottom).toBeLessThanOrEqual(metrics.cardBottom)
      expect(metrics.cardBottom).toBeLessThanOrEqual(metrics.nextTop)
    }
  })

  test('module bounding boxes remain consistent between normal and edit mode', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const module = page.locator('[data-module-id="fleet-pulse"]')
    await expect(module).toBeVisible()
    const normalBox = await module.boundingBox()
    expect(normalBox).not.toBeNull()

    // Enter edit mode
    await page.getByRole('button', { name: 'Customize' }).click()
    // Close the drawer so the page layout is unobstructed
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()

    // In edit mode
    await expect(page.locator('[data-edit-mode="true"]').first()).toBeVisible()
    const editBox = await module.boundingBox()
    expect(editBox).not.toBeNull()

    expect(Math.abs(normalBox!.width - editBox!.width)).toBeLessThanOrEqual(2)
    expect(Math.abs(normalBox!.height - editBox!.height)).toBeLessThanOrEqual(2)
  })

  test('drag overlay matches the dragged module bounding box dimensions', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Enter edit mode and close drawer
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()

    const targetModule = page.locator('[data-module-id="approval-queue"]')
    await expect(targetModule).toBeVisible()
    const beforeBox = await targetModule.boundingBox()
    expect(beforeBox).not.toBeNull()

    const handle = targetModule.locator('button[aria-label="Drag to reorder approval-queue"]')
    await expect(handle).toBeVisible()
    const handleBox = await handle.boundingBox()
    expect(handleBox).not.toBeNull()

    // Drag slightly to activate dnd-kit DragOverlay
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      handleBox!.x + handleBox!.width / 2 + 15,
      handleBox!.y + handleBox!.height / 2 + 30,
    )

    const overlay = page.locator('[data-slot="drag-overlay"]')
    await expect(overlay).toBeVisible()
    const overlayBox = await overlay.boundingBox()
    expect(overlayBox).not.toBeNull()

    // Overlay must match the dragged module's dimensions
    expect(Math.abs(overlayBox!.width - beforeBox!.width)).toBeLessThanOrEqual(4)
    expect(Math.abs(overlayBox!.height - beforeBox!.height)).toBeLessThanOrEqual(4)

    await page.mouse.up()
    await expect(overlay).toBeHidden()
  })

  test('changing module size with S/M/L picker updates grid dimensions and bounding box', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Enter edit mode and close drawer
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()

    const module = page.locator('[data-module-id="approval-queue"]')
    await expect(module).toBeVisible()
    await expect(module).toHaveAttribute('data-cols', '2')
    await expect(module).toHaveAttribute('data-rows', '2')

    // Read grid metrics directly from the computed styles
    const { colWidth, rowHeight, gap } = await page.evaluate(() => {
      const grid = document.querySelector('.dashboard-bento-grid') as HTMLElement
      const style = window.getComputedStyle(grid)
      const cols = style.gridTemplateColumns.split(' ').map((s) => parseFloat(s))
      const colWidth = cols[0] || 0
      const rowHeight = parseFloat(style.getPropertyValue('--dashboard-row')) || 176
      const gap = parseFloat(style.gap) || 16
      return { colWidth, rowHeight, gap }
    })
    expect(colWidth).toBeGreaterThan(0)
    expect(rowHeight).toBeGreaterThan(0)

    const expectedDim = (cols: number, rows: number) => ({
      width: cols * colWidth + (cols - 1) * gap,
      height: rows * rowHeight + (rows - 1) * gap,
    })

    // Medium size: 2 cols x 2 rows
    const medBox = await module.boundingBox()
    expect(medBox).not.toBeNull()
    const medExpected = expectedDim(2, 2)
    expect(Math.abs(medBox!.width - medExpected.width)).toBeLessThanOrEqual(4)
    expect(Math.abs(medBox!.height - medExpected.height)).toBeLessThanOrEqual(4)

    // Change size to large (2 cols, 3 rows)
    const largeBtn = module.getByRole('button', { name: 'large size' })
    await largeBtn.click()
    await expect(module).toHaveAttribute('data-cols', '2')
    await expect(module).toHaveAttribute('data-rows', '3')
    const largeBox = await module.boundingBox()
    expect(largeBox).not.toBeNull()
    const largeExpected = expectedDim(2, 3)
    expect(Math.abs(largeBox!.width - largeExpected.width)).toBeLessThanOrEqual(4)
    expect(Math.abs(largeBox!.height - largeExpected.height)).toBeLessThanOrEqual(4)

    // Change size to small (1 col, 2 rows)
    const smallBtn = module.getByRole('button', { name: 'small size' })
    await smallBtn.click()
    await expect(module).toHaveAttribute('data-cols', '1')
    await expect(module).toHaveAttribute('data-rows', '2')
    const smallBox = await module.boundingBox()
    expect(smallBox).not.toBeNull()
    const smallExpected = expectedDim(1, 2)
    expect(Math.abs(smallBox!.width - smallExpected.width)).toBeLessThanOrEqual(4)
    expect(Math.abs(smallBox!.height - smallExpected.height)).toBeLessThanOrEqual(4)
  })

  test('header links have uniform "View all" text, descriptive accessible names, and no trailing arrows across Business and Homelab presets', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // 1. Business preset checks
    const businessExpected = [
      { moduleId: 'needs-attention', href: '/devices', ariaLabel: 'View all devices' },
      { moduleId: 'approval-queue', href: '/devices/queue', ariaLabel: 'View approval queue' },
      { moduleId: 'live-sessions', href: '/sessions', ariaLabel: 'View all sessions' },
      { moduleId: 'fleet-overview', href: '/devices', ariaLabel: 'View all devices' },
      { moduleId: 'admin-activity', href: '/audit', ariaLabel: 'View audit log' },
    ]

    for (const exp of businessExpected) {
      const module = page.locator(`[data-module-id="${exp.moduleId}"]`)
      await expect(module).toBeVisible()
      const header = module.locator('[data-slot="card-header"]')
      const headerLink = header.locator('a')
      await expect(headerLink).toHaveCount(1)
      await expect(headerLink).toHaveText('View all')
      await expect(headerLink).toHaveAttribute('href', exp.href)
      await expect(headerLink).toHaveAttribute('aria-label', exp.ariaLabel)

      // Content has no "View all" or trailing arrow links
      const content = module.locator('[data-slot="card-content"]')
      await expect(content.locator('a:has-text("View all")')).toHaveCount(0)
      await expect(content.locator('a:has-text("→")')).toHaveCount(0)
    }

    // Verify across the whole dashboard grid in Business preset: no link contains '→'
    const grid = page.locator('[data-slot="dashboard-grid"]')
    await expect(grid.locator('a:has-text("→")')).toHaveCount(0)

    // 2. Switch to Homelab preset
    await page.getByRole('button', { name: 'Customize' }).click()
    const drawer = page.getByRole('dialog', { name: 'Customize dashboard' })
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'Homelab' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
    await expect(drawer).toBeHidden()

    const homelabExpected = [
      { moduleId: 'quick-connect', href: '/devices', ariaLabel: 'View all devices' },
      { moduleId: 'live-sessions', href: '/sessions', ariaLabel: 'View all sessions' },
      { moduleId: 'fleet-overview', href: '/devices', ariaLabel: 'View all devices' },
      { moduleId: 'needs-attention', href: '/devices', ariaLabel: 'View all devices' },
      { moduleId: 'recent-sessions', href: '/sessions', ariaLabel: 'View all sessions' },
    ]

    for (const exp of homelabExpected) {
      const module = page.locator(`[data-module-id="${exp.moduleId}"]`)
      await expect(module).toBeVisible()
      const header = module.locator('[data-slot="card-header"]')
      const headerLink = header.locator('a')
      await expect(headerLink).toHaveCount(1)
      await expect(headerLink).toHaveText('View all')
      await expect(headerLink).toHaveAttribute('href', exp.href)
      await expect(headerLink).toHaveAttribute('aria-label', exp.ariaLabel)

      // Content has no "View all" or trailing arrow links
      const content = module.locator('[data-slot="card-content"]')
      await expect(content.locator('a:has-text("View all")')).toHaveCount(0)
      await expect(content.locator('a:has-text("→")')).toHaveCount(0)
    }

    // Verify across the whole dashboard grid in Homelab preset: no link contains '→'
    await expect(grid.locator('a:has-text("→")')).toHaveCount(0)

    // Clean up / reset to Business
    await page.getByRole('button', { name: 'Customize' }).click()
    await drawer.getByRole('button', { name: 'Business' }).click()
    await drawer.getByRole('button', { name: 'Save layout' }).click()
  })
})
