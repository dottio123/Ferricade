// The console as a User (?mock-role=user) sees it: their devices, sessions and
// own activity, and Connect; nothing the server would refuse them. Every test
// fails if any response of the session is a 403.
import type { Page } from '@playwright/test'
import { expect, mockReady, test as base } from './support/test'

const USER = 'mock-role=user'
const panel = '[data-slot="device-detail"]'
const NO_DEVICES = 'No devices are assigned to you yet. Ask an owner to assign devices or groups.'

const test = base.extend<{ refused: void }>({
  refused: [
    async ({ page }, use) => {
      const refused: string[] = []
      page.on('response', (res) => {
        if (res.status() === 403) refused.push(`${res.request().method()} ${res.url()}`)
      })
      await use()
      expect(refused, '403 responses').toEqual([])
    },
    { auto: true },
  ],
})

/** The ids of the devices the signed-in account's GET /devices lists. */
async function listedIds(page: Page, query = ''): Promise<string[]> {
  await mockReady(page)
  return page.evaluate(async (q) => {
    const res = await fetch(`/admin/api/v1/devices?limit=200${q}`)
    const body = (await res.json()) as { items: { id: string }[] }
    return body.items.map((d) => d.id)
  }, query)
}

test('the nav has Command Center, Devices, Sessions and Audit Log, and no admin items', async ({
  page,
}) => {
  await page.goto(`/?${USER}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link')).toHaveText([
    'Command Center',
    'Devices',
    'Sessions',
    'Audit Log',
  ])
  const sidebar = page.locator('aside')
  await expect(sidebar.getByRole('link', { name: 'Groups' })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: 'Tags' })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: 'Policies' })).toHaveCount(0)
  await expect(sidebar.getByRole('link', { name: 'System Settings' })).toHaveCount(0)
  await expect(sidebar.locator('[data-slot="badge"]')).toHaveCount(0)

  // About stays, and the profile menu keeps User settings.
  await expect(sidebar.getByRole('button', { name: 'About' })).toBeVisible()
  await sidebar.getByRole('button', { name: /^Profile:/ }).click()
  await expect(page.getByRole('menuitem', { name: 'User settings' })).toBeVisible()
})

for (const path of ['/settings', '/settings/users', '/groups', '/tags', '/devices/queue']) {
  test(`${path} redirects to / without showing its content`, async ({ page }) => {
    await page.goto(`${path}?${USER}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
  })
}

test('/account stays reachable', async ({ page }) => {
  await page.goto(`/account?${USER}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/account')
})

test('Devices has no state filter, selection, or approve, edit or delete controls', async ({
  page,
}) => {
  await page.goto(`/devices?${USER}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
  const rows = page.locator('[data-slot="devices-table"] tbody tr[data-device-id]')
  await expect(rows.first()).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Filter by state' })).toHaveCount(0)
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /^(Approve|Reject|Delete|Archive|Restore)/ }),
  ).toHaveCount(0)
  await expect(page.locator('[data-slot="bulk-action-bar"]')).toHaveCount(0)
  // Approved devices only.
  await expect(page.locator('[data-slot="devices-table"] tbody')).not.toContainText(
    /pending|rejected|archived/,
  )
})

test('the device panel is read-only and Connect works', async ({ page }) => {
  await page.goto(`/devices?${USER}`)
  await page.locator('[data-slot="devices-table"] tbody tr[data-device-id] a').first().click()
  const detail = page.locator(panel)
  await expect(detail).toBeVisible()
  await expect(detail.getByText('Recent Remote Sessions')).toBeVisible()
  await expect(detail.getByText('Recent Audit Log')).toBeVisible()
  await expect(
    detail.getByRole('button', { name: /^(Delete|Archive|Restore|Approve|Reject)/ }),
  ).toHaveCount(0)
  await expect(detail.getByRole('button', { name: 'Save changes' })).toHaveCount(0)
  await expect(detail.getByLabel(/^Alias/)).toHaveCount(0)
  await expect(detail.getByRole('combobox', { name: 'Add tag' })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: /^(Dismiss|Accept new uuid)/ })).toHaveCount(0)

  await detail.getByRole('button', { name: 'Connect' }).click()
  await detail.locator('[data-slot="connect-link-box"] summary').click()
  await expect(detail.getByRole('link', { name: 'Open in RustDesk' })).toHaveAttribute(
    'href',
    /^rustdesk:\/\//,
  )
})

test('the Command Center shows only the scoped modules', async ({ page }) => {
  await page.goto(`/?${USER}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
  const modules = page.locator('[data-module-id]')
  await expect(modules.first()).toBeVisible()
  const ids = await modules.evaluateAll((els) => els.map((el) => el.getAttribute('data-module-id')))
  for (const id of ['approval-queue', 'admin-activity', 'activity-trend']) {
    expect(ids).not.toContain(id)
  }
})

test('Fleet pulse hides Pending for a User and keeps it for an Owner', async ({ page }) => {
  const fleetPulse = page.locator('[data-module-id="fleet-pulse"]')

  await page.goto(`/?${USER}`)
  await expect(fleetPulse).toBeVisible()
  for (const label of ['Online', 'Live sessions', 'Open alerts']) {
    await expect(fleetPulse.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(fleetPulse.getByText('Pending', { exact: true })).toHaveCount(0)

  await page.goto('/')
  await expect(fleetPulse).toBeVisible()
  await expect(fleetPulse.getByText('Pending', { exact: true })).toBeVisible()
})

test('with no grants the Command Center says so and nothing fails', async ({ page }) => {
  await page.goto(`/?${USER}&mock-grants=none`)
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
  await expect(page.getByText(NO_DEVICES)).toBeVisible()
  await expect(page.locator('[data-module-id]')).toHaveCount(0)
  await page.goto(`/devices?${USER}&mock-grants=none`)
  await expect(page.getByText(NO_DEVICES)).toBeVisible()
})

test('the Audit Log says "Your actions" and has no actor filter', async ({ page }) => {
  await page.goto(`/audit?${USER}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Audit Log' })).toBeVisible()
  await expect(page.getByText('Your actions')).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Filter by actor' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Filter by action' })).toBeVisible()
})

test('the command palette offers a User nothing they cannot use', async ({ page }) => {
  await page.goto(`/?${USER}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
  await page.keyboard.press('Control+k')
  const palette = page.locator('[data-slot="command-dialog"]')
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('option')).toHaveText([
    /Toggle theme/,
    /Command Center/,
    /Devices/,
    /Sessions/,
    /Audit Log/,
  ])
})

// The browser logs each 404 of a device outside the grants as a console error.
test.describe('a device outside the grants', () => {
  test.use({
    allowConsoleErrors: [
      /status of 404 \(Not Found\) \(.*\/admin\/api\/v1\/devices\/[0-9a-f-]{36}(\/policy)?\)$/,
    ],
  })

  test('a device moved out of the grants while its panel is open shows "not found" after the resync', async ({
    page,
  }) => {
    await page.goto(`/devices?${USER}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Devices' })).toBeVisible()
    // The first approved device is granted directly; the others are visible through the group.
    const ids = await listedIds(page)
    const direct = await page.evaluate(() => window.__ferricadeMock!.approvedDeviceId())
    const viaGroup = ids.find((id) => id !== direct)
    expect(viaGroup, 'a device the User sees through a group').toBeDefined()

    await page.goto(`/devices?device=${viaGroup}&${USER}`)
    await expect(page.locator(panel)).toBeVisible()
    await mockReady(page)
    await page.evaluate((id) => window.__ferricadeMock!.moveDevice(id, null), viaGroup!)
    await expect(page.locator('[data-slot="device-detail-not-found"]')).toContainText(
      'This device no longer exists.',
    )
  })

  test('a deep link to an ungranted device shows "not found" once', async ({ page, browser }) => {
    await page.goto(`/audit?${USER}`)
    const visible = new Set(await listedIds(page))

    // The same fixtures as an Owner sees them: pick an approved device outside the grants.
    const owner = await browser.newPage()
    await owner.goto('/audit')
    const all = await listedIds(owner, '&state=approved')
    await owner.close()
    const ungranted = all.find((id) => !visible.has(id))
    expect(ungranted, 'an approved device outside the grants').toBeDefined()

    const asked: string[] = []
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === `/admin/api/v1/devices/${ungranted}`)
        asked.push(req.url())
    })
    await page.goto(`/devices?device=${ungranted}&${USER}`)
    await expect(page.locator('[data-slot="device-detail-not-found"]')).toBeVisible()
    // The shell refetches what was fetched before its event stream opened, once (src/live);
    // a retry loop or a toast storm would keep asking.
    await page.waitForTimeout(1500)
    const settled = asked.length
    expect(settled).toBeLessThanOrEqual(2)
    await page.waitForTimeout(1500)
    expect(asked).toHaveLength(settled)
    await expect(page.locator('[data-slot="toast"]')).toHaveCount(0)
  })
})

test('no session list offers Disconnect', async ({ page }) => {
  await page.goto(`/sessions?${USER}`)
  await expect(page.locator('[data-slot="session-row"]').first()).toBeVisible()
  await expect(page.getByRole('button', { name: /^Disconnect / })).toHaveCount(0)

  await page.locator('[data-slot="session-row"] [data-slot="device-link"]').first().click()
  const detail = page.locator(panel)
  await expect(detail.getByText('Recent Remote Sessions')).toBeVisible()
  await expect(detail.getByRole('button', { name: /^Disconnect / })).toHaveCount(0)

  await page.goto(`/?${USER}`)
  await expect(page.locator('[data-slot="live-session-item"]').first()).toBeVisible()
  await expect(page.getByRole('button', { name: /^Disconnect / })).toHaveCount(0)
})
