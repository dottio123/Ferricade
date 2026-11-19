import { expect, mockReady, test } from './support/test'

test.use({ allowConsoleErrors: [/status of 409 \(Conflict\)/] })

test.describe('Devices page & features', () => {
  test('filtering respects reduced motion for rows', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/devices')
    const table = page.locator('[data-slot="devices-table"]')
    await expect(table.locator('tbody tr').first()).toBeVisible()
    await page.getByPlaceholder('Search ID, alias, host, user…').fill('plexbox')
    await expect(page).toHaveURL(/q=plexbox/)
    await expect(table.locator('tbody tr').first()).toBeVisible()
    const motion = await table.locator('tbody').evaluate((body) => ({
      animations: body
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === 'running').length,
      transforms: Array.from(body.querySelectorAll('tr'))
        .map((row) => (row as HTMLElement).style.transform)
        .filter(Boolean),
    }))
    expect(motion).toEqual({ animations: 0, transforms: [] })
  })
  test('lists devices with table columns and handles search and clearing filters', async ({
    page,
  }) => {
    await page.goto('/devices')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

    // Table should render with rows
    const table = page.locator('[data-slot="devices-table"]')
    await expect(table).toBeVisible()

    const initialRows = table.locator('tbody tr')
    await expect(initialRows.first()).toBeVisible()
    const initialCount = await initialRows.count()
    expect(initialCount).toBeGreaterThan(0)

    // Type in search box to filter
    const searchInput = page.getByPlaceholder('Search ID, alias, host, user…')
    await searchInput.fill('plexbox')

    // Wait for debounce and query update
    await expect(page).toHaveURL(/q=plexbox/)
    const filteredRows = table.locator('tbody tr')
    await expect(filteredRows.first()).toBeVisible()
    expect(await filteredRows.count()).toBeLessThanOrEqual(initialCount)

    // Clear filters button resets filter
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(searchInput).toHaveValue('')
    await expect(page).not.toHaveURL(/q=plexbox/)
  })

  test('filters to devices without a group using the Ungrouped option', async ({ page }) => {
    await page.goto('/devices')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
    await mockReady(page)
    const expectedIds = await page.evaluate(async () => {
      const response = await fetch('/admin/api/v1/devices?ungrouped=true&limit=200')
      const body = (await response.json()) as { items: { id: string; group_id: string | null }[] }
      return body.items.filter((device) => device.group_id === null).map((device) => device.id)
    })

    await page.getByRole('button', { name: 'Filter by group' }).click()
    await page.getByRole('treeitem', { name: 'Ungrouped' }).click()
    await expect(page).toHaveURL(/[?&]group=ungrouped/)
    await expect(page.getByRole('button', { name: 'Remove Ungrouped filter' })).toBeVisible()
    const rows = page.locator('[data-slot="devices-table"] tbody tr')
    await expect(rows).toHaveCount(expectedIds.length)
    const actualIds = await rows.evaluateAll((items) =>
      items.map((row) => row.getAttribute('data-device-id')),
    )
    expect(actualIds).toEqual(expectedIds)
    for (const row of await rows.all()) {
      await expect(row.locator('td').nth(6)).toHaveText('No group')
    }
  })

  test('filters by state, online, os, group, and tag, updating URL and clearing', async ({
    page,
  }) => {
    await page.goto('/devices')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

    const table = page.locator('[data-slot="devices-table"]')
    await expect(table).toBeVisible()
    const initialRowsCount = await table.locator('tbody tr').count()
    expect(initialRowsCount).toBeGreaterThan(0)

    // 1. State filter
    await page
      .getByRole('combobox')
      .filter({ hasText: /State:/ })
      .click()
    await page.getByRole('option', { name: 'Approved' }).click()
    await expect(page).toHaveURL(/[?&]state=approved/)

    // 2. Online filter
    await page
      .getByRole('combobox')
      .filter({ hasText: /Status:/ })
      .click()
    await page.getByRole('option', { name: 'Online' }).click()
    await expect(page).toHaveURL(/[?&]online=true/)

    // 3. OS filter
    const osInput = page.getByPlaceholder('Filter OS…')
    await osInput.fill('win')
    await expect(page).toHaveURL(/[?&]os=win/)

    // 4. Group filter
    await page.getByRole('button', { name: 'Filter by group' }).click()
    await page.getByRole('treeitem', { name: 'Office', exact: true }).click()
    await expect(page).toHaveURL(/[?&]group=/)

    // 5. Tag filter
    await page.getByRole('combobox').filter({ hasText: /Tag:/ }).click()
    const firstTagOption = page.getByRole('option').filter({ hasNotText: 'Tag: All' }).first()
    await firstTagOption.click()
    await expect(page).toHaveURL(/[?&]tag=/)

    // Clear filters button resets all
    const clearButton = page
      .locator('[data-slot="devices-filter-bar"]')
      .getByRole('button', { name: 'Clear filters' })
    await expect(clearButton).toBeVisible()
    await clearButton.click()

    // Assert URL has none of the filter parameters
    await expect(page).not.toHaveURL(/[?&]state=/)
    await expect(page).not.toHaveURL(/[?&]online=/)
    await expect(page).not.toHaveURL(/[?&]os=/)
    await expect(page).not.toHaveURL(/[?&]group=/)
    await expect(page).not.toHaveURL(/[?&]tag=/)
    await expect(osInput).toHaveValue('')
  })

  test('opens device detail sheet, displays specs, and edits alias', async ({ page }) => {
    await page.goto('/devices')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

    // Click the first device link in the table to open Sheet
    const firstDeviceLink = page.locator('[data-slot="devices-table"] tbody tr a').first()
    await firstDeviceLink.click()

    // Sheet should open and URL should update with ?device=
    await expect(page).toHaveURL(/[?&]device=/)
    const detailPanel = page.locator('[data-slot="device-detail"]')
    await expect(detailPanel).toBeVisible()

    // Check read-only specs are present
    await expect(detailPanel.getByText('Hardware & System Specifications')).toBeVisible()
    await expect(detailPanel.getByText('Operating System')).toBeVisible()
    await expect(detailPanel.getByText('RustDesk ID:')).toBeVisible()

    // Edit alias
    const aliasInput = detailPanel.locator('#device-alias')
    const originalAlias = await aliasInput.inputValue()
    const newAlias = `${originalAlias || 'Device'} Updated`
    await aliasInput.fill(newAlias)

    const saveButton = detailPanel.getByRole('button', { name: 'Save changes' })
    await expect(saveButton).toBeEnabled()
    await saveButton.click()
    await expect(
      page.locator('[data-slot="toast-title"]').getByText('Device updated'),
    ).toBeVisible()

    // Success toast
    await expect(
      page.locator('[data-slot="toast-title"]').getByText('Device updated', { exact: true }),
    ).toBeVisible()

    // Close the sheet
    await detailPanel.getByRole('button', { name: 'Close device details' }).click()
    await expect(page).not.toHaveURL(/[?&]device=/)
  })

  test('creates a tag from the panel', async ({ page }) => {
    await page.goto('/devices')
    await mockReady(page)
    const id = await page.evaluate(async () => {
      const response = await fetch('/admin/api/v1/devices?state=approved&limit=1')
      const devices = (await response.json()) as { items: { id: string }[] }
      return devices.items[0]!.id
    })
    await page.goto(`/devices?device=${id}`)

    const detailPanel = page.locator('[data-slot="device-detail"]')
    await expect(detailPanel).toBeVisible()
    const addTag = detailPanel.getByRole('combobox', { name: 'Add tag' })
    await expect(addTag).toBeEnabled()
    await addTag.click()
    await page.getByRole('option', { name: 'Create tag…' }).click()
    await page.getByLabel('Tag name').fill('e2e-new-tag')
    await page.getByRole('button', { name: 'Create tag', exact: true }).click()

    await expect(page.locator('[data-slot="tag-form-dialog"]')).toBeHidden()
    await expect(detailPanel.getByText('e2e-new-tag', { exact: true })).toBeVisible()
    const saveButton = detailPanel.getByRole('button', { name: 'Save changes' })
    await expect(saveButton).toBeEnabled()
    await saveButton.click()
    await expect(
      page.locator('[data-slot="toast-title"]').getByText('Device updated'),
    ).toBeVisible()

    await expect
      .poll(
        async () =>
          page.evaluate(async (deviceId) => {
            const [deviceResponse, tagsResponse] = await Promise.all([
              fetch(`/admin/api/v1/devices/${deviceId}`),
              fetch('/admin/api/v1/tags?limit=200'),
            ])
            const device = (await deviceResponse.json()) as { tags: { name: string }[] }
            const tags = (await tagsResponse.json()) as { items: { name: string }[] }
            return {
              deviceHasTag: device.tags.some((tag) => tag.name === 'e2e-new-tag'),
              tagExists: tags.items.some((tag) => tag.name === 'e2e-new-tag'),
            }
          }, id),
        { timeout: 10_000 },
      )
      .toEqual({ deviceHasTag: true, tagExists: true })
  })

  test('offers only Create tag when every tag is applied', async ({ page }) => {
    await page.goto('/devices')
    await mockReady(page)
    const id = await page.evaluate(async () => {
      const [devicesResponse, tagsResponse] = await Promise.all([
        fetch('/admin/api/v1/devices?state=approved&limit=200').then((response) => response.json()),
        fetch('/admin/api/v1/tags?limit=200').then((response) => response.json()),
      ])
      const devices = devicesResponse as { items: { id: string; tags: unknown[] }[] }
      const tags = tagsResponse as { items: unknown[] }
      return devices.items.find((device) => device.tags.length < tags.items.length)!.id
    })
    await page.goto(`/devices?device=${id}`)

    const detailPanel = page.locator('[data-slot="device-detail"]')
    const addTag = detailPanel.getByRole('combobox', { name: 'Add tag' })
    for (let i = 0; i < 20; i++) {
      await addTag.click()
      const options = page.getByRole('option')
      if ((await options.count()) === 1) {
        await page.keyboard.press('Escape')
        break
      }
      await options.first().click()
    }

    await expect(addTag).toBeEnabled()
    await addTag.click()
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect(page.getByRole('option', { name: 'Create tag…' })).toBeVisible()
  })

  test('shows the name-taken error when creating a duplicate tag from the panel', async ({
    page,
  }) => {
    await page.goto('/devices')
    await mockReady(page)
    const id = await page.evaluate(async () => {
      const response = await fetch('/admin/api/v1/devices?state=approved&limit=1')
      const devices = (await response.json()) as { items: { id: string }[] }
      return devices.items[0]!.id
    })
    await page.goto(`/devices?device=${id}`)

    const detailPanel = page.locator('[data-slot="device-detail"]')
    await detailPanel.getByRole('combobox', { name: 'Add tag' }).click()
    await page.getByRole('option', { name: 'Create tag…' }).click()
    await page.getByLabel('Tag name').fill('server')
    await page.getByRole('button', { name: 'Create tag', exact: true }).click()

    await expect(page.getByText('A tag with this name already exists.')).toBeVisible()
    await expect(detailPanel.getByText('server', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('navigates directly to /devices/:id and renders device page', async ({ page }) => {
    // Navigate to /devices first to get an ID
    await page.goto('/devices')
    const firstDeviceLink = page.locator('[data-slot="devices-table"] tbody tr a').first()
    await firstDeviceLink.click()
    await expect(page).toHaveURL(/[?&]device=/)

    const url = new URL(page.url())
    const deviceId = url.searchParams.get('device')
    expect(deviceId).toBeTruthy()

    // Directly navigate to /devices/:id
    await page.goto(`/devices/${deviceId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Device' })).toBeVisible()
    await expect(page.locator('[data-slot="device-detail"]')).toBeVisible()
  })

  test('link box row keeps its height while the link refetches at 390 px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/devices?state=approved')
    await page
      .getByRole('link', { name: /Details/ })
      .first()
      .click()
    const detailPanel = page.locator('[data-slot="device-detail"]')
    const linkBox = detailPanel.locator('[data-slot="connect-link-box"]')
    await linkBox.locator('summary').click()
    const openLink = linkBox.getByRole('link', { name: 'Open in RustDesk' })
    await expect(openLink).toBeVisible()
    const field = linkBox.getByRole('textbox', { name: 'Link', exact: true })
    const measure = async () => ({
      row: (await openLink.locator('..').boundingBox())!.height,
      // Relative to the box: clicking the switch scrolls the page.
      fieldY: (await field.boundingBox())!.y - (await linkBox.boundingBox())!.y,
    })
    const idle = await measure()

    // Hold the link's next fetch while the force-relay switch triggers it. page.route cannot
    // do this: the mock API answers from a service worker, which it never sees.
    await page.evaluate(() => {
      const w = window as unknown as { releaseConnect: () => void }
      const held = new Promise<void>((resolve) => (w.releaseConnect = resolve))
      const real = window.fetch
      window.fetch = async (...args) => {
        const first = args[0]
        const url = first instanceof Request ? first.url : String(first)
        if (/\/devices\/[^/]+\/connect/.test(url)) await held
        return real(...args)
      }
    })
    await detailPanel.locator('#force-relay').click()
    await expect(linkBox.getByText('Getting link…')).toBeVisible()
    const loading = await measure()
    await page.evaluate(() =>
      (window as unknown as { releaseConnect: () => void }).releaseConnect(),
    )
    await expect(linkBox.getByText('Getting link…')).toBeHidden()

    expect(Math.abs(loading.row - idle.row)).toBeLessThanOrEqual(1)
    expect(Math.abs(loading.fieldY - idle.fieldY)).toBeLessThanOrEqual(1)
  })

  test('connect actions generate rustdesk:// links and display commands', async ({ page }) => {
    // Filter to approved devices so Connect section is available
    await page.goto('/devices?state=approved')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

    const firstDeviceLink = page.locator('[data-slot="devices-table"] tbody tr a').first()
    await expect(firstDeviceLink).toBeVisible()
    await firstDeviceLink.click()

    await expect(page).toHaveURL(/[?&]device=/)
    const detailPanel = page.locator('[data-slot="device-detail"]')
    await expect(detailPanel).toBeVisible()

    // 1. Standard Connect
    const connectButton = detailPanel.getByRole('button', { name: 'Connect', exact: true })
    await expect(connectButton).toBeVisible()
    await connectButton.click()

    // The link box stays closed after Connect; open it to read the link
    const linkBox = detailPanel.locator('[data-slot="connect-link-box"]')
    await expect(linkBox).not.toHaveJSProperty('open', true)
    await linkBox.locator('summary').click()
    const openLink = detailPanel.getByRole('link', { name: 'Open in RustDesk' })
    await expect(openLink).toHaveAttribute('href', /^rustdesk:\/\/\d+@[^?]+\?key=/)

    // The copy fields should be displayed
    await expect(linkBox.getByText('RustDesk Connect Link')).toHaveCount(1) // the summary only
    await expect(linkBox.getByRole('textbox', { name: 'Link', exact: true })).toBeVisible()
    await expect(detailPanel.locator('[data-slot="copy-field"]').first()).toBeVisible()

    // 2. File transfer + Force relay
    // Select "File transfer" action
    await detailPanel.locator('#connect-action').click()
    await page.getByRole('option', { name: 'File transfer' }).click()

    // Toggle "Force relay" switch
    await detailPanel.locator('#force-relay').click()

    // Click Connect again
    await connectButton.click()

    // Wait for href to update to the file-transfer with relay link
    await expect(openLink).toHaveAttribute('href', /^rustdesk:\/\/file-transfer\/.*\/r@/)
  })

  test('resolves client uuid mismatch alert', async ({ page }) => {
    // Select data deterministically via API to pick a device with open_alerts
    await page.goto('/devices')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
    await expect(page.locator('[data-slot="devices-table"] tbody tr').first()).toBeVisible()

    const deviceWithAlert = await page.evaluate(async () => {
      const res = await fetch('/admin/api/v1/devices?limit=200').then((r) => r.json())
      return res.items.find(
        (d: { open_alerts?: unknown[] }) => d.open_alerts && d.open_alerts.length > 0,
      )
    })
    expect(deviceWithAlert).toBeDefined()
    expect(deviceWithAlert.id).toBeTruthy()

    await page.goto(`/devices/${deviceWithAlert.id}`)

    const detailPanel = page.locator('[data-slot="device-detail"]')
    await expect(detailPanel).toBeVisible()

    // Assert alert card is visible
    const alertCard = detailPanel.locator('[data-slot="device-alert"]').first()
    await expect(alertCard).toBeVisible()
    await expect(alertCard).toContainText('Client UUID Mismatch')

    // Resolve alert via "Accept new uuid"
    const acceptButton = alertCard.getByRole('button', { name: 'Accept new uuid' })
    await acceptButton.click()

    // Toast notification confirms resolution
    await expect(
      page.locator('[data-slot="toast-title"]').getByText('Alert resolved', { exact: true }),
    ).toBeVisible()
  })

  test('approval queue lists pending devices and supports individual and bulk approve', async ({
    page,
  }) => {
    await page.goto('/devices/queue')
    await expect(page.getByRole('heading', { level: 1, name: 'Approval Queue' })).toBeVisible()

    const cards = page
      .locator('[data-slot="queue-bulk-toolbar"]')
      .locator('xpath=following-sibling::div//div[contains(@class, "border-border")]')
    await expect(cards.first()).toBeVisible()
    const initialCount = await cards.count()
    expect(initialCount).toBeGreaterThan(0)

    // Individual approve on the first card
    const firstApproveButton = cards.first().getByRole('button', { name: 'Approve' })
    await firstApproveButton.click()

    await expect(
      page.locator('[data-slot="toast-title"]').getByText('Device approved', { exact: true }),
    ).toBeVisible()

    // Bulk toolbar
    const bulkToolbar = page.locator('[data-slot="queue-bulk-toolbar"]')
    await expect(bulkToolbar).toBeVisible()

    // Select all visible
    await bulkToolbar.getByRole('checkbox', { name: 'Select all visible devices' }).click()
    await expect(bulkToolbar).toContainText('selected')

    // Bulk approve selected
    const bulkApproveButton = bulkToolbar.getByRole('button', { name: /Approve \(\d+\)/ })
    await bulkApproveButton.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('They can be connected to as soon as they are approved.')
    await dialog.getByRole('button', { name: /Approve \d+/ }).click()

    // Toast confirms bulk approval
    await expect(
      page.locator('[data-slot="toast-title"]').getByText(/\d+ devices approved/),
    ).toBeVisible()
  })

  test('approval queue card shows hostname, username and online state', async ({ page }) => {
    await page.goto('/devices/queue')
    const firstCard = page.locator('[data-device-id]').first()
    await expect(firstCard).toBeVisible()
    await expect(firstCard.locator('[data-slot="status-dot"]')).toBeVisible()
    await expect(firstCard).toContainText(/online|offline/i)
    await expect(firstCard.locator('[data-slot="queue-card-username"]')).toBeVisible()
  })

  test('bulk actions bar appears on row selection with counts and clears on filter change', async ({
    page,
  }) => {
    await page.goto('/devices')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

    const checkboxes = page.locator('[data-slot="devices-table"] tbody tr input[type="checkbox"]')
    await expect(checkboxes.first()).toBeVisible()

    // Select first two rows
    await checkboxes.nth(0).click()
    await checkboxes.nth(1).click()

    // Bulk action bar appears
    const bulkBar = page.locator('[data-slot="bulk-action-bar"]')
    await expect(bulkBar).toBeVisible()
    await expect(bulkBar).toContainText('2 selected')

    // Deselect all button works
    await bulkBar.getByRole('button', { name: 'Deselect all' }).click()
    await expect(bulkBar).toBeHidden()

    // Select again and ensure search change clears selection
    await checkboxes.first().click()
    await expect(bulkBar).toBeVisible()

    const searchInput = page.getByPlaceholder('Search ID, alias, host, user…')
    await searchInput.fill('something-else')
    await expect(bulkBar).toBeHidden()
  })

  test('does not apply layout transforms on large fleet (?mock=large)', async ({ page }) => {
    await page.goto('/devices?mock=large')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

    const tableContainer = page.locator('[data-slot="devices-table"]')
    await expect(tableContainer).toBeVisible()

    // Click Load more until loaded count exceeds 100
    const loadMoreButton = page.getByRole('button', { name: 'Load more' })
    await expect(loadMoreButton).toBeVisible()
    await loadMoreButton.click()

    await expect(loadMoreButton).toBeVisible()
    await loadMoreButton.click()

    const rows = tableContainer.locator('tbody tr')
    await expect(rows).toHaveCount(150)
    expect(await rows.count()).toBeGreaterThan(100)

    expect(
      await rows.evaluateAll((items) =>
        items.some((row) => getComputedStyle(row).transform !== 'none'),
      ),
    ).toBe(false)
  })

  test('live event status change triggers status dot pulse animation once on stable row key', async ({
    page,
  }) => {
    await page.goto('/devices')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

    // Identify the pending device row that will be approved
    const pendingRow = page.locator('tbody tr', { hasText: 'pending' }).first()
    await expect(pendingRow).toBeVisible()
    const targetId = await pendingRow.getAttribute('data-device-id')
    expect(targetId).toBeTruthy()

    // Target the specific row of that device id for before check
    const row = page.locator(`tbody tr[data-device-id="${targetId}"]`)
    const dot = row.locator('[data-testid="status-dot"]')
    await expect(dot).toHaveAttribute('data-status', 'pending')
    expect(await dot.getAttribute('class')).not.toContain('animate-status-pulse')

    // Approve pending device via live event mock control
    const approvedId = await page.evaluate(() => window.__ferricadeMock!.approvePendingDevice())
    expect(approvedId).toBe(targetId)

    // Target the exact same row by id for after check: stays mounted with stable key, status changes, dot pulses
    await expect(row).toBeVisible()
    const updatedDot = row.locator('[data-testid="status-dot"]')
    await expect(updatedDot).toHaveAttribute('data-status', /offline|online/)
    await expect(updatedDot).toHaveClass(/animate-status-pulse/)

    // Pulse animation completes and class is removed
    await expect(updatedDot).not.toHaveClass(/animate-status-pulse/, { timeout: 3000 })
  })

  test('status dot does not get pulse animation under prefers-reduced-motion: reduce', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/devices')
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()

    const pendingRow = page.locator('tbody tr', { hasText: 'pending' }).first()
    await expect(pendingRow).toBeVisible()
    const targetId = await pendingRow.getAttribute('data-device-id')
    expect(targetId).toBeTruthy()

    const row = page.locator(`tbody tr[data-device-id="${targetId}"]`)
    const dot = row.locator('[data-testid="status-dot"]')
    await expect(dot).toHaveAttribute('data-status', 'pending')

    // Approve pending device
    const approvedId = await page.evaluate(() => window.__ferricadeMock!.approvePendingDevice())
    expect(approvedId).toBe(targetId)

    await expect(row).toBeVisible()
    const updatedDot = row.locator('[data-testid="status-dot"]')
    await expect(updatedDot).toHaveAttribute('data-status', /offline|online/)

    // Reduced motion prevents animate-status-pulse from ever being added
    expect(await updatedDot.getAttribute('class')).not.toContain('animate-status-pulse')
  })
})
