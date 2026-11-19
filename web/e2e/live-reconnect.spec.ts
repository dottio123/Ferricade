// Review focus 2: the live stream drops. The UI keeps working on 15 s
// refetches, says "Reconnecting…" only after 10 s without a connection, and
// goes back to live updates when the stream returns.
//
// Every time here is measured on the page's clock, from the moment the mock
// dropped the stream, so a busy test runner does not eat into the bounds.
import type { Page } from '@playwright/test'
import { expect, mockReady, test } from './support/test'

test.setTimeout(60_000)

interface Shell {
  /** Milliseconds on the page's clock since the stream was dropped. */
  elapsed: number
  /** The Devices link's text, with its pending count. */
  devices: string
  reconnecting: boolean
  offline: boolean
}

/** Reads the shell in the page, once `at` ms have passed since `since` (the drop). */
function readShell(page: Page, since: number, at = 0): Promise<Shell> {
  return page.evaluate(
    async ([since, at]) => {
      const wait = since + at - performance.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      const links = [...document.querySelectorAll('nav a')]
      const statuses = [...document.querySelectorAll('[role="status"]')]
      return {
        elapsed: performance.now() - since,
        devices: links.find((a) => a.textContent?.startsWith('Devices'))?.textContent ?? '',
        reconnecting: statuses.some((s) => s.textContent?.includes('Reconnecting…')),
        offline: statuses.some((s) => s.textContent?.includes('Server offline')),
      }
    },
    [since, at] as const,
  )
}

/** Reads the shell every 100 ms until `done`; returns that first reading. */
async function waitForShell(
  page: Page,
  since: number,
  done: (shell: Shell) => boolean,
  timeout: number,
): Promise<Shell> {
  let seen: Shell | undefined
  await expect
    .poll(
      async () => {
        const shell = await readShell(page, since)
        if (done(shell)) seen = shell
        return seen !== undefined
      },
      { intervals: [100], timeout },
    )
    .toBe(true)
  return seen!
}

test('a change made while the stream is down shows within 16 s', async ({ page }) => {
  await page.goto('/devices')
  const devicesLink = page.getByRole('link', { name: /^Devices/ })
  const reconnecting = page.getByRole('status').filter({ hasText: 'Reconnecting…' })
  await expect(devicesLink).toContainText('6 pending')
  await mockReady(page)

  // The stream ends and stays down for 20 s; meanwhile a device is approved,
  // and its live event is lost with the stream.
  const droppedAt = await page.evaluate(() => {
    const at = window.__ferricadeMock!.dropEventStreams(20_000)
    window.__ferricadeMock!.approvePendingDevice()
    return at
  })

  // Quiet for the first 10 s.
  const quiet = await readShell(page, droppedAt, 9_000)
  expect(quiet.elapsed, 'read before the 10 s mark').toBeLessThan(10_000)
  expect(quiet.reconnecting).toBe(false)
  expect(quiet.devices).toContain('6 pending')

  const shown = await waitForShell(page, droppedAt, (s) => s.reconnecting, 5_000)
  expect(shown.elapsed).toBeGreaterThanOrEqual(9_900)

  // The 15 s fallback refetch shows the change: not before it (so neither the
  // lost live event nor the reconnect brought it), and within the plan's 16 s.
  const refetched = await waitForShell(
    page,
    droppedAt,
    (s) => s.devices.includes('5 pending'),
    10_000,
  )
  expect(refetched.elapsed).toBeGreaterThanOrEqual(14_500)
  expect(refetched.elapsed).toBeLessThanOrEqual(16_000)
  expect(refetched.reconnecting).toBe(true)

  // The stream comes back: the indicator goes, and live events flow again.
  await expect(reconnecting).toHaveCount(0, { timeout: 10_000 })
  await page.evaluate(() => window.__ferricadeMock!.approvePendingDevice())
  await expect(devicesLink).toContainText('4 pending', { timeout: 2_000 })
})

test.describe('server outage', () => {
  test.use({
    allowConsoleErrors: [
      /Failed to load resource: net::ERR_FAILED \(https?:\/\/[^/]+\/admin\/api\/v1\//,
    ],
  })

  test('the indicator reports an offline server and returns to Live', async ({ page }) => {
    // Keep the initial guard in flight past mockReady: mock controls being ready
    // does not mean the signed-in shell has finished loading.
    await page.addInitScript(() => {
      const fetchNow = window.fetch.bind(window)
      let firstAuthMe = true
      window.fetch = async (...args) => {
        const input = args[0]
        const url = input instanceof Request ? input.url : String(input)
        if (firstAuthMe && new URL(url, location.href).pathname === '/admin/api/v1/auth/me') {
          firstAuthMe = false
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        return fetchNow(...args)
      }
    })
    await page.goto('/devices')
    await mockReady(page)
    await expect(page.getByRole('button', { name: 'Connection status: Live' })).toBeVisible()
    const droppedAt = await page.evaluate(() => window.__ferricadeMock!.takeServerOffline(20_000))
    const quiet = await readShell(page, droppedAt, 9_000)
    expect(quiet.elapsed).toBeLessThan(10_000)
    expect(quiet.offline).toBe(false)
    const offline = await waitForShell(page, droppedAt, (s) => s.offline, 7_000)
    expect(offline.elapsed).toBeGreaterThanOrEqual(9_900)
    expect(offline.elapsed).toBeLessThan(26_000)
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible({
      timeout: 20_000,
    })
  })
})

test('the Live dot pulses continuously unless reduced motion is requested', async ({ page }) => {
  await page.goto('/devices')
  await mockReady(page)
  const dot = page.getByRole('status').locator('span[aria-hidden="true"]')
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible()
  expect(await dot.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => dot.evaluate((element) => element.getAnimations().length)).toBe(0)
})
