// The device panel opens over whatever page a device name was clicked on
// (?device=<id>, handled by the app shell), so the page underneath keeps its
// filters and scroll position; Escape, the close button and Back close it.
import { expect, mockReady, test } from './support/test'

const panel = '[data-slot="device-detail"]'

test('opens from /sessions, keeps the filters, and closes with Escape', async ({ page }) => {
  await page.goto('/sessions?active=false')
  const link = page.locator('[data-slot="session-row"] [data-slot="device-link"]').first()
  await link.click()

  await expect(page.locator(panel)).toBeVisible()
  const opened = new URL(page.url())
  expect(opened.pathname).toBe('/sessions')
  expect(opened.searchParams.get('active')).toBe('false')
  expect(opened.searchParams.get('device')).toBeTruthy()

  await page.keyboard.press('Escape')
  await expect(page.locator(panel)).toBeHidden()
  const closed = new URL(page.url())
  expect(closed.pathname).toBe('/sessions')
  expect(closed.searchParams.get('active')).toBe('false')
  expect(closed.searchParams.has('device')).toBe(false)
})

test('sheet content finishes its close animation before unmounting', async ({ page }) => {
  await page.goto('/devices')
  const link = page.locator('[data-slot="devices-table"] tbody [data-slot="device-link"]').first()
  await link.click()

  const content = page.locator('[data-slot="sheet-content"]')
  const overlay = page.locator('[data-slot="sheet-overlay"]')
  await expect(content).toBeVisible()
  const counts = await page.evaluate(async () => {
    const mounted = () => ({
      content: document.querySelectorAll('[data-slot="sheet-content"]').length,
      overlay: document.querySelectorAll('[data-slot="sheet-overlay"]').length,
    })
    ;(document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    )
    const immediate = mounted()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    return { immediate, nextFrame: mounted() }
  })
  expect(counts.immediate).toEqual({ content: 1, overlay: 1 })
  expect(counts.nextFrame).toEqual({ content: 1, overlay: 1 })
  await expect(content).toHaveCount(0, { timeout: 1000 })
  await expect(overlay).toHaveCount(0, { timeout: 1000 })
  await expect.poll(() => new URL(page.url()).searchParams.has('device')).toBe(false)
})

test('a dialog opened from the panel stays above the sheet', async ({ page }) => {
  await page.goto('/devices')
  await page.locator('[data-slot="devices-table"] tbody [data-slot="device-link"]').first().click()
  await expect(page.locator(panel)).toBeVisible()

  await page.locator(panel).getByRole('button', { name: 'Delete', exact: true }).click()
  const dialog = page.locator('[data-slot="device-delete-dialog"]')
  await expect(dialog).toBeVisible()
  const cancel = dialog.getByRole('button', { name: 'Cancel' })
  expect(
    await cancel.evaluate((button) => {
      const rect = button.getBoundingClientRect()
      return document
        .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        ?.closest('[data-slot="device-delete-dialog"]')
        ?.getAttribute('data-slot')
    }),
  ).toBe('device-delete-dialog')
  await cancel.click()
  await expect(dialog).toBeHidden()
  await expect(page.locator(panel)).toBeVisible()
})

test('Back closes the panel and stays on the page', async ({ page }) => {
  await page.goto('/sessions')
  await page.locator('[data-slot="session-row"] [data-slot="device-link"]').first().click()
  await expect(page.locator(panel)).toBeVisible()

  await page.goBack()
  await expect(page.locator(panel)).toBeHidden()
  expect(new URL(page.url()).pathname).toBe('/sessions')
})

test('opens from the Command Center and from the Audit Log', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-module-id="approval-queue"] [data-slot="device-link"]').first().click()
  await expect(page.locator(panel)).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/')

  await page.goto('/audit?action=device.approved')
  await page.locator('[data-slot="audit-event-item"] [data-slot="device-link"]').first().click()
  await expect(page.locator(panel)).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/audit')
})

test('a link with ?device= opens the panel over that page', async ({ page }) => {
  // A page first, so the mock API is there to ask for a device id.
  await page.goto('/audit')
  await mockReady(page)
  const id = await page.evaluate(async () => {
    const res = await fetch('/admin/api/v1/devices?state=approved&limit=1')
    const body = (await res.json()) as { items: { id: string }[] }
    return body.items[0]!.id
  })
  await page.goto(`/audit?device=${id}`)
  // The panel is modal, so the page under it is hidden from role queries.
  await expect(page.locator(panel)).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/audit')
})

test('opening another device from inside the panel switches it', async ({ page }) => {
  await page.goto('/')
  const links = page.locator('[data-module-id="approval-queue"] [data-slot="device-link"]')
  await links.nth(0).click()
  const first = new URL(page.url()).searchParams.get('device')
  await page.keyboard.press('Escape')
  await links.nth(1).click()
  await expect(page.locator(panel)).toBeVisible()
  expect(new URL(page.url()).searchParams.get('device')).not.toBe(first)
})

test('reopened panel stays clickable after audited API writes', async ({ page }) => {
  await page.goto('/devices')
  await mockReady(page)

  await page.evaluate(async () => {
    const auth = await fetch('/admin/api/v1/auth/me').then((response) => response.json())
    const devices = await fetch('/admin/api/v1/devices?limit=2').then((response) => response.json())
    if (devices.items.length < 2) throw new Error('Expected two devices for audited writes')
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf_token }
    const writes = [
      await fetch(`/admin/api/v1/devices/${devices.items[0].id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ alias: 'Panel regression first' }),
      }),
      await fetch(`/admin/api/v1/devices/${devices.items[1].id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ alias: 'Panel regression second' }),
      }),
    ]
    for (const response of writes) {
      if (!response.ok) throw new Error(`API write failed: ${response.status}`)
    }
  })

  // Let the audited device updates refetch the page before opening the panel.
  await page.waitForTimeout(500)

  const rows = page.locator('[data-slot="devices-table"] tbody tr')
  await expect(rows.nth(1)).toBeVisible()
  await rows.nth(0).locator('[data-slot="device-link"]').first().click()
  await expect(page.locator(panel)).toBeVisible()
  for (let cycle = 0; cycle < 5; cycle++) {
    await page.keyboard.press('Escape')
    await expect(page.locator(panel)).toBeHidden()

    await rows
      .nth((cycle + 1) % 2)
      .locator('[data-slot="device-link"]')
      .first()
      .click()
    await expect(page.locator(panel)).toBeVisible()
    await page.waitForTimeout(1500)

    const pinButton = page.locator(panel).getByRole('button', { name: /^(Pin|Unpin) device$/ })
    const previousLabel = await pinButton.getAttribute('aria-label')
    await pinButton.click({ timeout: 5000 })
    await expect(
      page.locator(panel).getByRole('button', {
        name: previousLabel === 'Pin device' ? 'Unpin device' : 'Pin device',
      }),
    ).toBeVisible()
  }
})

test('policy section shows push off', async ({ page }) => {
  await page.goto('/devices')
  await mockReady(page)

  const rows = page.locator('[data-slot="devices-table"] tbody tr')
  await expect(rows.first()).toBeVisible()
  await rows.nth(0).locator('[data-slot="device-link"]').first().click()
  await expect(page.locator(panel)).toBeVisible()

  const policySection = page.locator('[data-slot="device-policy-section"]')
  await expect(policySection).toBeVisible()

  await expect(policySection).toContainText('Policy: Default · Off. Policy push is off.')
  await expect(policySection).toContainText('Always reachable (policy allows password logins)')
})

test('policy section drives the access window lifecycle', async ({ page }) => {
  await page.goto('/devices')
  await mockReady(page)

  const { defaultPolicyId, csrfToken } = await page.evaluate(async () => {
    const auth = await fetch('/admin/api/v1/auth/me').then((r) => r.json())
    const policies = await fetch('/admin/api/v1/policies').then((r) => r.json())
    const defaultPol = policies.items.find((p: { is_default: boolean }) => p.is_default)
    return { defaultPolicyId: defaultPol.id as string, csrfToken: auth.csrf_token as string }
  })

  // Update default policy so always_reachable becomes false (approve-mode: click)
  await page.evaluate(
    async ({ polId, token }) => {
      const res = await fetch(`/admin/api/v1/policies/${polId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({
          settings: { 'approve-mode': 'click', 'verification-method': 'use-both-passwords' },
        }),
      })
      if (!res.ok) throw new Error(`Failed to update default policy: ${res.status}`)
    },
    { polId: defaultPolicyId, token: csrfToken },
  )

  // Turn policy push on via PUT /settings/policy-push
  await page.evaluate(
    async ({ token }) => {
      const res = await fetch('/admin/api/v1/settings/policy-push', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ enabled: true }),
      })
      if (!res.ok) throw new Error(`Failed to turn policy push on: ${res.status}`)
    },
    { token: csrfToken },
  )

  // Open a device in-app once after state changes
  const rows = page.locator('[data-slot="devices-table"] tbody tr')
  await expect(rows.first()).toBeVisible()
  await rows.nth(0).locator('[data-slot="device-link"]').first().click()
  await expect(page.locator(panel)).toBeVisible()
  const id = new URL(page.url()).searchParams.get('device')!
  expect(id).toBeTruthy()

  const policySection = page.locator('[data-slot="device-policy-section"]')
  await expect(policySection).toBeVisible()

  // Now policy push is on and not always reachable: Allow access button is visible
  await expect(policySection).toContainText('Policy: Default')
  const allowBtn = policySection.getByRole('button', { name: 'Allow access' })
  await expect(allowBtn).toBeVisible()

  // Owner clicks "Allow access" -> selects 1 hour -> clicks "Open window"
  await allowBtn.click()
  const durationSelect = policySection.locator('[data-slot="access-window-duration"]')
  await expect(durationSelect).toBeVisible()
  await durationSelect.selectOption('60')
  const openWindowBtn = policySection.getByRole('button', { name: 'Open window' })
  await openWindowBtn.click()

  // Panel updates: shows "Reachable until" and a "Close now" button
  await expect(policySection).toContainText('Reachable until')
  const closeNowBtn = policySection.getByRole('button', { name: 'Close now' })
  await expect(closeNowBtn).toBeVisible()

  // Owner clicks "Close now" -> sees the "Closing... not confirmed" warning
  await closeNowBtn.click()
  const unconfirmedWarning = policySection.locator('[data-slot="unconfirmed-close-warning"]')
  await expect(unconfirmedWarning).toBeVisible()
  await expect(unconfirmedWarning).toContainText('Closing… not confirmed by the device')

  // Mock helper simulates the device confirming: window.__ferricadeMock.setDeviceVersionSeen(id, true)
  await page.evaluate((devId) => window.__ferricadeMock!.setDeviceVersionSeen(devId, true), id)

  // Warning clears, Allow access button is visible again
  await expect(unconfirmedWarning).toBeHidden()
  await expect(policySection.getByRole('button', { name: 'Allow access' })).toBeVisible()
})
