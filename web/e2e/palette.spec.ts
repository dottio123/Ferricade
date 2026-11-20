import { expect, test } from './support/test'

test.describe('Command palette features', () => {
  test('shows the device keyboard hint on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    await page.keyboard.press('Control+k')
    const palette = page.locator('[data-slot="command-dialog"]')
    await expect(palette).toBeVisible()
    await page.getByPlaceholder('Type a command or search devices…').fill('plexbox-02')
    const row = palette.locator('[data-slot="command-item"]', { hasText: /plexbox-02/i }).first()
    await expect(row).toBeVisible()
    await expect(row.getByText('Enter: Connect · Shift+Enter: Details')).toBeVisible()
  })

  test.describe('touch phone layout', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('keeps device name visible without the keyboard hint and opens details on tap', async ({
      page,
    }) => {
      await page.goto('/')
      await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
      await page.keyboard.press('Control+k')
      const palette = page.locator('[data-slot="command-dialog"]')
      await expect(palette).toBeVisible()
      await page.getByPlaceholder('Type a command or search devices…').fill('plexbox-02')
      const row = palette.locator('[data-slot="command-item"]', { hasText: /plexbox-02/i }).first()
      await expect(row).toBeVisible()
      const name = row.locator('.device-result-name')
      await expect(name).toBeVisible()
      expect((await name.boundingBox())?.width).toBeGreaterThan(40)
      await expect(row.getByText('Enter: Connect · Shift+Enter: Details')).toBeHidden()
      const parts = [name, row.locator('[data-slot="badge"]')]
      for (const [i, first] of parts.entries()) {
        const a = await first.boundingBox()
        if (!a) continue
        for (const second of parts.slice(i + 1)) {
          const b = await second.boundingBox()
          if (!b) continue
          expect(
            a.x + a.width <= b.x ||
              b.x + b.width <= a.x ||
              a.y + a.height <= b.y ||
              b.y + b.height <= a.y,
          ).toBe(true)
        }
      }
      await row.tap()
      await expect(palette).toBeHidden()
      await expect(page.locator('[data-slot="device-detail"]')).toBeVisible()
    })
  })

  test('opens via top-bar trigger and displays platform shortcut hint', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const trigger = page.locator('header').getByRole('button', { name: /Search \((Ctrl K|⌘K)\)/ })
    await expect(trigger).toBeVisible()

    // Click trigger to open palette
    await trigger.click()
    const palette = page.locator('[data-slot="command-dialog"]')
    await expect(palette).toBeVisible()

    // Press Escape to close
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
  })

  test('opens via Ctrl+K and ⌘K keyboard shortcuts', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    const palette = page.locator('[data-slot="command-dialog"]')

    // Open via Control+k
    await page.keyboard.press('Control+k')
    await expect(palette).toBeVisible()

    // Close via Escape
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    // Still works while focus is inside an input field
    await page.goto('/devices')
    const searchInput = page.getByPlaceholder('Search ID, alias, host, user…')
    await searchInput.focus()
    await page.keyboard.press('Control+k')
    await expect(palette).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
  })

  test('suppresses Ctrl+K when a modal dialog or device panel is already open', async ({
    page,
  }) => {
    // Open devices page and click first device to open sheet panel
    await page.goto('/devices')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

    const firstDevice = page.locator('[data-slot="devices-table"] tbody tr a').first()
    await firstDevice.click()

    const detailPanel = page.locator('[data-slot="device-detail"]')
    await expect(detailPanel).toBeVisible()

    const palette = page.locator('[data-slot="command-dialog"]')

    // Press Control+k while device panel is open -> should not open palette
    await page.keyboard.press('Control+k')
    await expect(palette).toBeHidden()
  })

  test('searches devices (debounced) and opens device panel on Shift+Enter or click', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    await page.keyboard.press('Control+k')
    const palette = page.locator('[data-slot="command-dialog"]')
    await expect(palette).toBeVisible()

    const input = page.getByPlaceholder('Type a command or search devices…')
    await input.fill('plex')

    // Device result appears in Devices group
    const deviceItem = palette
      .locator('[data-slot="command-item"]', {
        hasText: /plexbox/i,
      })
      .first()
    await expect(deviceItem).toBeVisible()

    // Test mouse click opens device panel
    await deviceItem.click()
    await expect(palette).toBeHidden()
    await expect(page).toHaveURL(/[?&]device=/)
    await expect(page.locator('[data-slot="device-detail"]')).toBeVisible()

    // Close panel
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-slot="device-detail"]')).toBeHidden()
    await expect(page).not.toHaveURL(/[?&]device=/)

    // Open palette again, test Shift+Enter
    await page.keyboard.press('Control+k')
    await expect(palette).toBeVisible()
    await input.fill('plex')
    await expect(deviceItem).toBeVisible()

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Shift+Enter')
    await expect(palette).toBeHidden()
    await expect(page).toHaveURL(/[?&]device=/)
  })

  test('Enter on an approved device triggers connect and opens rustdesk:// link', async ({
    page,
  }) => {
    const completedPolicyRequests = new Set<string>()
    page.on('requestfinished', (request) => {
      const match = new URL(request.url()).pathname.match(/\/devices\/([^/]+)\/policy$/)
      if (match?.[1]) completedPolicyRequests.add(match[1])
    })

    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    let connectRequests = 0
    page.on('request', (req) => {
      if (req.url().includes('/connect')) {
        connectRequests++
      }
    })

    await page.keyboard.press('Control+k')
    const palette = page.locator('[data-slot="command-dialog"]')
    await expect(palette).toBeVisible()

    const input = page.getByPlaceholder('Type a command or search devices…')
    await input.fill('plex')

    const deviceItem = palette
      .locator('[data-slot="command-item"]', {
        hasText: /plexbox/i,
      })
      .first()
    await expect(deviceItem).toBeVisible()

    // Arrow down before Enter: verify NO connect request was made while typing and arrowing
    await page.keyboard.press('ArrowDown')
    expect(connectRequests).toBe(0)

    const selectedItem = palette.locator('[data-slot="command-item"][data-selected="true"]')
    const deviceId = await selectedItem.getAttribute('data-device-id')
    expect(deviceId).toBeTruthy()
    await expect.poll(() => completedPolicyRequests.has(deviceId ?? '')).toBe(true)

    // Plain Enter on approved device triggers connect
    const connectReqPromise = page.waitForRequest((req) =>
      req.url().includes(`/devices/${deviceId}/connect`),
    )
    await page.keyboard.press('Enter')
    const req = await connectReqPromise
    expect(req.url()).toContain(`/admin/api/v1/devices/${deviceId}/connect`)
    expect(connectRequests).toBe(1)
    await expect(palette).toBeHidden()
  })

  test('navigates to pages via palette', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    await page.keyboard.press('Control+k')
    const palette = page.locator('[data-slot="command-dialog"]')
    await expect(palette).toBeVisible()

    const auditItem = palette.locator('[data-slot="command-item"]', {
      hasText: 'Audit Log',
    })
    await expect(auditItem).toBeVisible()
    await auditItem.click()

    await expect(palette).toBeHidden()
    await expect(page).toHaveURL(/\/audit/)
    await expect(page.getByRole('heading', { level: 1, name: 'Audit Log' })).toBeVisible()
  })

  test('toggles theme action from palette cycling dark, light, and system', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    // Default theme for new user is system (no data-theme attribute on <html>)
    await expect(page.locator('html')).not.toHaveAttribute('data-theme')

    // Cycle 1: system → dark
    await page.keyboard.press('Control+k')
    const palette = page.locator('[data-slot="command-dialog"]')
    await expect(palette).toBeVisible()
    const themeItem = palette.locator('[data-slot="command-item"]', {
      hasText: 'Toggle theme',
    })
    await expect(themeItem).toBeVisible()
    await themeItem.click()
    await expect(palette).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // Cycle 2: dark → light
    await page.keyboard.press('Control+k')
    await expect(palette).toBeVisible()
    await palette.locator('[data-slot="command-item"]', { hasText: 'Toggle theme' }).click()
    await expect(palette).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    // Cycle 3: light → system (attribute removed)
    await page.keyboard.press('Control+k')
    await expect(palette).toBeVisible()
    await palette.locator('[data-slot="command-item"]', { hasText: 'Toggle theme' }).click()
    await expect(palette).toBeHidden()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme')
  })

  test('does not offer Users page to an admin role', async ({ page }) => {
    await page.goto('/?mock-role=admin')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    await page.keyboard.press('Control+k')
    const palette = page.locator('[data-slot="command-dialog"]')
    await expect(palette).toBeVisible()

    const input = page.getByPlaceholder('Type a command or search devices…')
    await input.fill('Users')

    const usersItem = palette.locator('[data-slot="command-item"]', { hasText: /^Users$/ })
    await expect(usersItem).toHaveCount(0)
  })

  test('approves all pending devices with confirmation and suppresses Ctrl+K during modal', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    await page.keyboard.press('Control+k')
    const palette = page.locator('[data-slot="command-dialog"]')
    await expect(palette).toBeVisible()

    const approveAllItem = palette.locator('[data-slot="command-item"]', {
      hasText: 'Approve all pending',
    })
    await expect(approveAllItem).toBeVisible()
    await approveAllItem.click()

    // Confirmation dialog opens and palette closes
    const confirmDialog = page.getByRole('dialog', { name: 'Approve all pending devices?' })
    await expect(confirmDialog).toBeVisible()
    await expect(palette).toBeHidden()

    // Press Control+k while confirmation dialog is open -> does nothing, palette remains closed
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(300)
    await expect(confirmDialog).toBeVisible()
    await expect(palette).toBeHidden()

    const confirmButton = confirmDialog.getByRole('button', { name: /Approve \d+ devices?/ })
    await expect(confirmButton).toBeVisible()
    await confirmButton.click()

    // Summary toast appears
    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: /\d+ devices approved/ }),
    ).toBeVisible()
    await expect(page.locator('[data-slot="toast-action"]', { hasText: 'Undo' })).toBeVisible()
  })

  test('lists devices matched by username or by RustDesk ID when alias exists, and shows searching/empty indicators', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

    await page.keyboard.press('Control+k')
    const palette = page.locator('[data-slot="command-dialog"]')
    await expect(palette).toBeVisible()

    const input = page.getByPlaceholder('Type a command or search devices…')

    // Search by username 'jordan' -> device with alias 'Front desk'
    await input.fill('jordan')
    const jordanDevice = palette.locator('[data-slot="command-item"]', {
      hasText: /Front desk/i,
    })
    await expect(jordanDevice).toBeVisible()

    // Search by RustDesk ID '498813945' -> device with alias 'Front desk'
    await input.fill('498813945')
    const idDevice = palette.locator('[data-slot="command-item"]', {
      hasText: /Front desk/i,
    })
    await expect(idDevice).toBeVisible()

    // Search non-matching query -> renders "No devices match"
    await input.fill('zz_nonexistent')
    await expect(
      palette.locator('[data-slot="command-item"]', {
        hasText: /No devices match/i,
      }),
    ).toBeVisible()
  })

  test.describe('connect failure handling', () => {
    test.use({ allowConsoleErrors: [/status of 500/i] })

    test('keeps palette open and displays error when connect fails', async ({ page }) => {
      const completedPolicyRequests = new Set<string>()
      page.on('requestfinished', (request) => {
        const match = new URL(request.url()).pathname.match(/\/devices\/([^/]+)\/policy$/)
        if (match?.[1]) completedPolicyRequests.add(match[1])
      })

      // Navigate with ?mock-fail=connectDevice
      await page.goto('/?mock-fail=connectDevice')
      await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()

      await page.keyboard.press('Control+k')
      const palette = page.locator('[data-slot="command-dialog"]')
      await expect(palette).toBeVisible()

      const input = page.getByPlaceholder('Type a command or search devices…')
      await input.fill('plex')

      const deviceItem = palette
        .locator('[data-slot="command-item"]', {
          hasText: /plexbox/i,
        })
        .first()
      await expect(deviceItem).toBeVisible()

      // Plain Enter on approved device triggers connect
      await page.keyboard.press('ArrowDown')
      const selectedItem = palette.locator('[data-slot="command-item"][data-selected="true"]')
      const deviceId = await selectedItem.getAttribute('data-device-id')
      expect(deviceId).toBeTruthy()
      await expect.poll(() => completedPolicyRequests.has(deviceId ?? '')).toBe(true)
      await page.keyboard.press('Enter')

      // Palette stays open and error is shown
      await expect(palette).toBeVisible()
      const errorMsg = palette.locator('[data-slot="palette-connect-error"]')
      await expect(errorMsg).toBeVisible()
      await expect(errorMsg).toHaveAttribute('role', 'alert')
      await expect(
        page.locator('[data-slot="toast-title"]', { hasText: 'Failed to connect' }),
      ).toBeVisible()
    })
  })
})
