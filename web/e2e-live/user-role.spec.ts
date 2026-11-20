// Runs after flow.spec.ts has set up the owner and approved the first device.
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { startRdsim } from './support/stack'
import { totp } from './support/totp'

const API = '/admin/api/v1'
const GROUP = 'Live user devices'
const USER = { username: 'liveviewer', password: 'correct horse battery staple' }
const FIRST = 'sim-100000000'
const SECOND = 'sim-100000001'

const STEP_MS = 30_000

// flow.spec.ts records the TOTP step it spent; the server accepts only a
// later one, so wait for the clock to pass it and use the current step.
async function signInOwner(page: Page): Promise<void> {
  const owner = JSON.parse(readFileSync('test-results-live/owner.json', 'utf8')) as {
    username: string
    password: string
    totpSecret: string
    lastStep: number
  }
  const wait = (owner.lastStep + 1) * STEP_MS - Date.now()
  if (wait > 0) await page.waitForTimeout(wait)
  await page.goto('/sign-in')
  await page.getByLabel('Username').fill(owner.username)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Two-factor code' })).toBeVisible()
  await page.getByLabel('Code').fill(totp(owner.totpSecret, Date.now()))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
}

test('an owner grants a User one live device, then removes it by moving the device', async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(180_000)
  await signInOwner(owner)
  const stopRdsim = startRdsim(['-devices', '2', '-interval', '2s'], '5m')
  try {
    await test.step('approve two online devices and put only the first in a group', async () => {
      await owner.goto('/devices/queue')
      await expect(owner.getByText(SECOND).first()).toBeVisible({ timeout: 30_000 })
      await owner.getByRole('button', { name: `Approve ${SECOND}` }).click()
      await expect(owner.locator('[data-slot="toast-title"]')).toHaveText('Device approved')

      await owner.goto('/groups')
      await owner.getByRole('button', { name: 'New group' }).click()
      await owner.getByLabel('Group name').fill(GROUP)
      await owner.getByRole('button', { name: 'Create group' }).click()
      await expect(owner.getByText(GROUP)).toBeVisible()

      await owner.goto('/devices?state=approved')
      await owner.locator('[data-slot="devices-table"]').getByRole('link', { name: FIRST }).click()
      const detail = owner.locator('[data-slot="device-detail"]')
      await expect(detail).toBeVisible()
      await detail.locator('#device-group').click()
      await owner.getByRole('treeitem', { name: GROUP, exact: true }).click()
      await detail.getByRole('button', { name: 'Save changes' }).click()
      await expect(detail.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    })

    const devicesResponse = await owner.request.get(`${API}/devices?state=approved`)
    expect(devicesResponse.status()).toBe(200)
    const devices = (await devicesResponse.json()) as {
      items: { id: string; hostname: string; group_id: string | null }[]
    }
    const first = devices.items.find((device) => device.hostname === FIRST)
    const second = devices.items.find((device) => device.hostname === SECOND)
    expect(first?.group_id).toBeTruthy()
    expect(second?.group_id).toBeNull()
    expect(second?.id).toBeTruthy()

    await test.step('create a User and assign the group through the Users page', async () => {
      await owner.goto('/settings/users')
      await owner.getByRole('button', { name: 'New user' }).click()
      const create = owner.locator('[data-slot="user-create-dialog"]')
      await create.getByLabel('Username').fill(USER.username)
      await create.getByLabel('Password', { exact: true }).fill(USER.password)
      await create.locator('#user-create-role').click()
      await owner.getByRole('option', { name: /^User/ }).click()
      await create.getByRole('button', { name: 'Create user' }).click()
      await expect(create).toHaveCount(0)
      await owner.getByRole('button', { name: `Assign devices to ${USER.username}` }).click()
      const assign = owner.locator('[data-slot="assign-devices-dialog"]')
      await assign.getByRole('checkbox', { name: GROUP, exact: true }).check()
      await assign.getByRole('button', { name: 'Save' }).click()
      await expect(owner.getByText('Assigned devices saved', { exact: true })).toBeVisible()
    })

    const context = await browser.newContext()
    try {
      const user = await context.newPage()
      const refused: string[] = []
      user.on('response', (response) => {
        if (
          response.status() === 403 &&
          new URL(response.url()).pathname !== `${API}/stats/history`
        )
          refused.push(`${response.request().method()} ${response.url()}`)
      })

      await test.step('sign in and see only the granted online device', async () => {
        await user.goto('/sign-in')
        await user.getByLabel('Username').fill(USER.username)
        await user.getByLabel('Password').fill(USER.password)
        await user.getByRole('button', { name: 'Sign in' }).click()
        const enrol = user.getByRole('heading', { name: 'Set up two-factor authentication' })
        const home = user.getByRole('heading', { level: 1, name: 'Command Center' })
        await expect(enrol.or(home)).toBeVisible()
        if (await enrol.isVisible()) {
          const secret = await user.getByLabel('Secret key (if you cannot scan)').inputValue()
          await user.getByLabel('Verification code').fill(totp(secret, Date.now()))
          await user.getByRole('button', { name: 'Verify and continue' }).click()
        }
        await expect(home).toBeVisible()
        await user.goto('/devices')
        const rows = user.locator('[data-slot="devices-table"] tbody tr[data-device-id]')
        await expect(rows).toHaveCount(1)
        await expect(rows.first()).toHaveAttribute('data-device-id', first!.id)
        await expect(rows.first()).toContainText(FIRST)
        await expect(rows.first()).toContainText('Online')
        await rows.first().getByRole('link', { name: FIRST }).click()
        const detail = user.locator('[data-slot="device-detail"]')
        await detail.getByRole('button', { name: 'Connect', exact: true }).click()
        await detail.locator('[data-slot="connect-link-box"] summary').click()
        await expect(detail.getByRole('link', { name: 'Open in RustDesk' })).toHaveAttribute(
          'href',
          /^rustdesk:\/\//,
        )
      })

      await test.step('hide the ungranted device and deny fleet history', async () => {
        await user.goto(`/devices?device=${second!.id}`)
        await expect(user.locator('[data-slot="device-detail-not-found"]')).toBeVisible()
        await user.goto('/settings')
        await expect(user).toHaveURL('http://localhost:21220/')
        const historyStatus = await user.evaluate(
          async (path) => (await fetch(path)).status,
          `${API}/stats/history`,
        )
        expect(historyStatus).toBe(403)
      })

      await test.step('show only this User’s sign-in and connect activity', async () => {
        await user.goto('/audit')
        await expect(user.getByText('Your actions')).toBeVisible()
        const audit = await user.evaluate(async (path) => {
          const response = await fetch(path)
          return { status: response.status, body: await response.json() }
        }, `${API}/audit`)
        expect(audit.status).toBe(200)
        const items = (audit.body as { items: { action: string; actor_user_id: string }[] }).items
        expect(items.map((item) => item.action)).toContain('auth.login')
        expect(items.map((item) => item.action)).toContain('device.connect_link')
        expect(new Set(items.map((item) => item.actor_user_id)).size).toBe(1)
      })

      await test.step('remove the group membership while the User keeps Devices open', async () => {
        await user.goto('/devices')
        await expect(
          user.locator('[data-slot="devices-table"] tbody tr[data-device-id]'),
        ).toHaveCount(1)
        await owner.goto(`/devices?device=${first!.id}`)
        const detail = owner.locator('[data-slot="device-detail"]')
        await expect(detail).toBeVisible()
        await detail.locator('#device-group').click()
        await owner.getByRole('treeitem', { name: 'No group', exact: true }).click()
        await detail.getByRole('button', { name: 'Save changes' }).click()
        await expect(
          user.locator('[data-slot="devices-table"] tbody tr[data-device-id]'),
        ).toHaveCount(0)
      })

      expect(refused, 'unexpected 403 responses in the User context').toEqual([])
    } finally {
      await context.close()
    }
  } finally {
    stopRdsim()
  }
})
