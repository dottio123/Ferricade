// The test() every spec uses: it fails a test on any console error or uncaught
// page error, which includes every CSP violation (Chromium reports each one as
// a console error). A spec that expects a particular error (a 401 when the
// session ends) lists it in allowConsoleErrors.
import { expect, test as base, type Page } from '@playwright/test'
import type { MockControls } from '../../src/mocks/controls'

export interface Options {
  /**
   * Console errors this test expects, matched against "<message> (<source URL>)";
   * for a failed request the source is the request's URL.
   */
  allowConsoleErrors: RegExp[]
}

export const test = base.extend<Options & { consoleGuard: void }>({
  allowConsoleErrors: [[], { option: true }],
  consoleGuard: [
    async ({ page, allowConsoleErrors }, use) => {
      const errors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return
        const text = `${msg.text()} (${msg.location().url})`
        if (!allowConsoleErrors.some((re) => re.test(text))) errors.push(text)
      })
      page.on('pageerror', (err) => errors.push(`uncaught: ${err.message}`))
      await use()
      expect(errors, 'console errors').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

/**
 * The browser's console line for a 401 answer to GET /admin/api/v1/auth/me:
 * how a page learns that nobody is signed in.
 */
export const AUTH_ME_401 =
  /status of 401 \(Unauthorized\) \(https?:\/\/[^/]+\/admin\/api\/v1\/auth\/me\)$/

/**
 * Waits for the mock API (src/mocks/controls.ts) to run in the page. Specs then
 * call it with page.evaluate(() => window.__ferricadeMock!.…()).
 */
export async function mockReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__ferricadeMock !== undefined)
}

/**
 * Records every securitypolicyviolation event the page fires, from the first
 * script on; the returned function reads them ("<directive> blocked <URI>").
 */
export async function recordViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __cspViolations: string[] }).__cspViolations = seen
    document.addEventListener('securitypolicyviolation', (e) => {
      seen.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`)
    })
  })
  return () =>
    page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)
}

export type { MockControls }
