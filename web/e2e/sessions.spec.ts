import { expect, mockReady, test } from './support/test'

test.describe('Sessions page', () => {
  test('loads sessions page with heading, stats card, filter bar, and session rows', async ({
    page,
  }) => {
    await page.goto('/sessions')
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()

    // Stats card and chart
    const statsCard = page.locator('[data-slot="sessions-stats-card"]')
    await expect(statsCard).toBeVisible()
    await expect(page.locator('[data-slot="sessions-chart-container"]')).toBeVisible()

    // Filter bar
    const filterBar = page.locator('[data-slot="sessions-filter-bar"]')
    await expect(filterBar).toBeVisible()

    // Sessions table and rows
    const table = page.locator('[data-slot="sessions-table-wrapper"]')
    await expect(table).toBeVisible()

    const rows = page.locator('[data-slot="session-row"]')
    await expect(rows.first()).toBeVisible()
    expect(await rows.count()).toBeGreaterThan(0)
  })

  test('switches stats range between 7d and 30d', async ({ page }) => {
    await page.goto('/sessions')
    const statsCard = page.locator('[data-slot="sessions-stats-card"]')
    await expect(statsCard).toBeVisible()

    // Click 30 days
    await statsCard.getByRole('button', { name: '30 days' }).click()
    await expect(page).toHaveURL(/stats_range=30d/)

    // Click 7 days
    await statsCard.getByRole('button', { name: '7 days' }).click()
    await expect(page).toHaveURL(/stats_range=7d/)
  })

  test('toggles include attempts switch to reveal connection attempts', async ({ page }) => {
    await page.goto('/sessions')
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()

    const attemptsSwitch = page.locator('#include-attempts-switch')
    await expect(attemptsSwitch).toBeVisible()
    await expect(attemptsSwitch).toHaveAttribute('data-state', 'unchecked')

    // Click to enable attempts
    await attemptsSwitch.click()
    await expect(page).toHaveURL(/attempts=true/)
    await expect(attemptsSwitch).toHaveAttribute('data-state', 'checked')
  })

  test('keeps the attempts switch in place when Reset appears on desktop and phone', async ({
    page,
  }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/sessions')
      const attemptsSwitch = page.locator('#include-attempts-switch')
      const relativePosition = () =>
        attemptsSwitch.evaluate((element) => {
          const switchBox = element.getBoundingClientRect()
          const barBox = element
            .closest('[data-slot="sessions-filter-bar"]')!
            .getBoundingClientRect()
          return { x: switchBox.x - barBox.x, y: switchBox.y - barBox.y }
        })
      const before = await relativePosition()
      await attemptsSwitch.click()
      await expect(
        page.locator('[data-slot="sessions-filter-bar"]').getByRole('button', { name: 'Reset' }),
      ).toBeVisible()
      const after = await relativePosition()
      expect(after).toEqual(before)
    }
  })

  test('fits the time range buttons without horizontal scrolling on phone widths', async ({
    page,
  }) => {
    for (const path of ['/sessions', '/audit']) {
      for (const width of [320, 360, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(path)
        const allTime = page.getByRole('button', { name: 'All time' })
        const row = allTime.locator('xpath=..')
        await expect(allTime).toBeVisible()
        const dimensions = await row.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          return {
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            left: bounds.left,
            right: bounds.right,
            buttons: [...element.querySelectorAll('button')].map((button) => {
              const rect = button.getBoundingClientRect()
              return { left: rect.left, right: rect.right }
            }),
          }
        })
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
        expect(dimensions.buttons).toHaveLength(5)
        for (const button of dimensions.buttons) {
          expect(button.left).toBeGreaterThanOrEqual(dimensions.left)
          expect(button.right).toBeLessThanOrEqual(dimensions.right)
        }
      }
    }
  })

  test('keeps the peer ID chip on one line at desktop and phone widths', async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/sessions')
      const chip = page.locator(
        '[data-slot="session-row"] [data-slot="mono-id"][aria-label^="Copy 34500423@"]',
      )
      await expect(chip).toBeVisible()
      const height = await chip.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          height: element.getBoundingClientRect().height,
          lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2,
        }
      })
      expect(height.height).toBeLessThan(height.lineHeight * 1.5)
    }
  })

  test('filters by session state (active vs ended)', async ({ page }) => {
    await page.goto('/sessions')
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()

    // Select Active only
    const statusSelect = page
      .locator('[data-slot="sessions-filter-bar"]')
      .getByRole('combobox')
      .first()
    await statusSelect.click()
    await page.getByRole('option', { name: 'Active only' }).click()

    await expect(page).toHaveURL(/active=true/)
    // Verify rows show Open badge (waits: the rows re-render after the URL changes)
    const openBadges = page.locator('[data-slot="session-row"]').getByText('Open', { exact: true })
    await expect(openBadges.first()).toBeVisible()

    // Select Ended only: no open sessions remain
    await statusSelect.click()
    await page.getByRole('option', { name: 'Ended only' }).click()
    await expect(page).toHaveURL(/active=false/)
    await expect(page.locator('[data-slot="session-row"]').first()).toBeVisible()
    await expect(openBadges).toHaveCount(0)
  })

  test('filters by time range presets and resets filters', async ({ page }) => {
    await page.goto('/sessions')
    const filterBar = page.locator('[data-slot="sessions-filter-bar"]')

    // Click 24h
    await filterBar.getByRole('button', { name: '24h' }).click()
    await expect(page).toHaveURL(/range=24h/)
    await expect(page).toHaveURL(/since=/)

    // Click 7d
    await filterBar.getByRole('button', { name: '7d' }).click()
    await expect(page).toHaveURL(/range=7d/)

    // Reset button should now be visible
    const resetButton = filterBar.getByRole('button', { name: 'Reset' })
    await expect(resetButton).toBeVisible()
    await resetButton.click()

    // Filters cleared
    await expect(page).toHaveURL('/sessions')
  })

  test('opens the device panel on this page when a device name is clicked', async ({ page }) => {
    await page.goto('/sessions')
    const firstDeviceLink = page
      .locator('[data-slot="session-row"]')
      .first()
      .locator('[data-slot="device-link"]')
    await expect(firstDeviceLink).toBeVisible()

    await firstDeviceLink.click()
    await expect(page).toHaveURL(/\/sessions\?.*device=/)
    await expect(page.locator('[data-slot="device-detail"]')).toBeVisible()
  })
})

// Disconnecting an open session, from the Sessions page, the device panel and the Live sessions
// widget (POST /sessions/{id}/disconnect; the mock keeps the session open and stamps the request).
test.describe('Disconnect a session', () => {
  const disconnectButton = /^Disconnect .+ from /
  const dialogName = 'Disconnect this session?'

  const places = [
    {
      name: 'the Sessions page',
      open: async (page: import('@playwright/test').Page) => {
        await page.goto('/sessions?active=true')
        return page.locator('[data-slot="session-row"]').first()
      },
    },
    {
      name: 'the device panel',
      open: async (page: import('@playwright/test').Page) => {
        await page.goto('/sessions?active=true')
        await page.locator('[data-slot="session-row"] [data-slot="device-link"]').first().click()
        const panel = page.locator('[data-slot="device-detail"]')
        await expect(panel).toBeVisible()
        // Pinned by id: once requested, the row has no button to find it by.
        const id = await panel
          .locator('[data-slot="device-session-row"]:has(button)')
          .first()
          .getAttribute('data-session-id')
        return panel.locator(`[data-session-id="${id}"]`)
      },
    },
    {
      name: 'the Live sessions widget',
      open: async (page: import('@playwright/test').Page) => {
        await page.goto('/')
        return page.locator('[data-slot="live-session-item"]').first()
      },
    },
  ]

  for (const place of places) {
    test(`confirm marks the session Disconnecting in ${place.name}`, async ({ page }) => {
      const row = await place.open(page)
      await row.getByRole('button', { name: disconnectButton }).click()
      const dialog = page.getByRole('dialog', { name: dialogName })
      await expect(dialog).toContainText('will be disconnected from')
      await expect(dialog).toContainText('It may take a few seconds.')
      await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(row.getByText('Disconnecting…')).toBeVisible()
      await expect(row.getByRole('button', { name: disconnectButton })).toHaveCount(0)
    })

    test(`Cancel changes nothing in ${place.name}`, async ({ page }) => {
      const row = await place.open(page)
      await row.getByRole('button', { name: disconnectButton }).click()
      const dialog = page.getByRole('dialog', { name: dialogName })
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
      await expect(row.getByRole('button', { name: disconnectButton })).toBeVisible()
      await expect(row.getByText('Disconnecting…')).toHaveCount(0)
    })
  }

  test.describe('a session that ended meanwhile', () => {
    test.use({ allowConsoleErrors: [/status of 409 .*\/sessions\/[^/]+\/disconnect/] })

    test('shows the already-ended toast', async ({ page }) => {
      await page.goto('/sessions?active=true')
      const row = page.locator('[data-slot="session-row"]').first()
      const id = await row.getAttribute('data-session-id')
      await row.getByRole('button', { name: disconnectButton }).click()
      const dialog = page.getByRole('dialog', { name: dialogName })
      await expect(dialog).toBeVisible()
      await mockReady(page)
      await page.evaluate((sid) => window.__ferricadeMock!.endSession(sid!, false), id)
      await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click()
      await expect(page.getByText('This session has already ended.', { exact: true })).toBeVisible()
    })
  })

  test('an ended-by-disconnect session says who ended it', async ({ page }) => {
    await page.goto('/sessions')
    const row = page.locator('[data-slot="session-row"]').first()
    const id = await row.getAttribute('data-session-id')
    await row.getByRole('button', { name: disconnectButton }).click()
    await page
      .getByRole('dialog', { name: dialogName })
      .getByRole('button', { name: 'Disconnect', exact: true })
      .click()
    await expect(row.getByText('Disconnecting…')).toBeVisible()
    await mockReady(page)
    await page.evaluate((sid) => window.__ferricadeMock!.endSession(sid!), id)
    await expect(row.getByText('Disconnected', { exact: true })).toBeVisible()
  })
})
