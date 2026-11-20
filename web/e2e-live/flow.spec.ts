// Phase 1b gate C1: the whole admin flow against a real ferricade, with rdsim
// as the fleet. One test, in order, because each step needs the one before
// (a fresh database, then setup, then a device to approve).
import { mkdirSync, writeFileSync } from 'node:fs'
import { AUTH_ME_401, expect, test } from '../e2e/support/test'
import { startRdsim, setupToken } from './support/stack'
import { totp } from './support/totp'

const ID_HOST = 'rd.e2e.test'
const PUBLIC_KEY = 'OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw='
const OWNER = { username: 'owner', password: 'correct horse battery staple' }
// rdsim's first device: ID 100000000, hostname sim-100000000.
const DEVICE = 'sim-100000000'

test.use({ allowConsoleErrors: [AUTH_ME_401] })

test('an admin sets up Ferricade, approves a device, connects and watches a session', async ({
  page,
}) => {
  let secret = ''
  let lastStep = 0

  await test.step('first-run setup in the browser', async () => {
    await page.goto('/first-run')
    await page.getByLabel('Setup token').fill(setupToken())
    await page.getByRole('button', { name: 'Continue' }).click()

    await page.getByLabel('Username').fill(OWNER.username)
    await page.getByLabel('Password').fill(OWNER.password)
    await page.getByRole('button', { name: 'Create owner and continue' }).click()

    const secretField = page.getByLabel('Secret key (if you cannot scan)')
    await expect(secretField).toBeVisible()
    secret = await secretField.inputValue()
    await page.getByLabel('Verification code').fill(totp(secret, Date.now()))
    await page.getByRole('button', { name: 'Verify and continue' }).click()

    await page.getByLabel('ID server host').fill(ID_HOST)
    await page.getByLabel('Relay server host').fill(ID_HOST)
    await page.getByLabel('Public key').fill(PUBLIC_KEY)
    await page.getByRole('button', { name: 'Save and check server' }).click()
    // No hbbs in this stack, so the reachability checks may fail; the wizard
    // then offers "Continue anyway".
    await page.getByRole('button', { name: /^Continue( anyway)?$/ }).click()

    await page.getByRole('button', { name: 'Finish setup' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Setup complete' })).toBeVisible()
    await expect(page.getByLabel('Server configuration string')).toBeVisible()
    await page.getByRole('button', { name: 'Sign in to the command center' }).click()
  })

  await test.step('sign in with password and TOTP', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
    await page.getByLabel('Username').fill(OWNER.username)
    await page.getByLabel('Password').fill(OWNER.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Two-factor code' })).toBeVisible()
    // The current step was spent verifying the secret; codes are single-use.
    const signInAt = Date.now() + 30_000
    lastStep = Math.floor(signInAt / 30_000)
    await page.getByLabel('Code').fill(totp(secret, signInAt))
    await page.getByRole('button', { name: 'Verify' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
  })

  const stopRdsim = startRdsim([
    '-devices',
    '1',
    '-interval',
    '2s',
    '-sessions',
    '4s',
    '-session-length',
    '12s',
  ])
  try {
    await test.step('a simulated device appears in the approval queue without a reload', async () => {
      await page.goto('/devices/queue')
      await expect(page.getByRole('heading', { level: 1, name: 'Approval Queue' })).toBeVisible()
      await expect(page.getByText(DEVICE).first()).toBeVisible({ timeout: 30_000 })
    })

    await test.step('approve it', async () => {
      await page.getByRole('button', { name: `Approve ${DEVICE}` }).click()
      await expect(
        page.locator('[data-slot="toast-title"]').getByText('Device approved', { exact: true }),
      ).toBeVisible()
    })

    await test.step('its connect link carries the ID server and key', async () => {
      await page.goto('/devices?state=approved')
      await page.locator('[data-slot="devices-table"]').getByRole('link', { name: DEVICE }).click()
      const panel = page.locator('[data-slot="device-detail"]')
      await expect(panel).toBeVisible()
      await panel.getByRole('button', { name: 'Connect', exact: true }).click()
      await panel.locator('[data-slot="connect-link-box"] summary').click()
      await expect(panel.getByRole('link', { name: 'Open in RustDesk' })).toHaveAttribute(
        'href',
        `rustdesk://100000000@${ID_HOST}?key=${PUBLIC_KEY.replaceAll('+', '%2B')}`,
      )
    })

    await test.step('a live session appears, then ends, without a reload', async () => {
      await page.goto('/sessions')
      await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()
      const open = page
        .locator('[data-slot="session-row"]')
        .filter({ hasText: DEVICE })
        .filter({ hasText: 'Open' })
        .first()
      await expect(open).toBeVisible({ timeout: 30_000 })
      const id = await open.getAttribute('data-session-id')
      expect(id).toBeTruthy()
      const row = page.locator(`[data-slot="session-row"][data-session-id="${id}"]`)
      await expect(row).toContainText('Closed', { timeout: 30_000 })
    })
  } finally {
    stopRdsim()
  }

  await page.context().storageState({ path: 'test-results-live/owner-state.json' })
  // user-role.spec.ts signs the owner in fresh (oidc.spec.ts ends this session).
  mkdirSync('test-results-live', { recursive: true })
  writeFileSync(
    'test-results-live/owner.json',
    JSON.stringify({
      username: OWNER.username,
      password: OWNER.password,
      totpSecret: secret,
      lastStep,
    }),
  )
})
