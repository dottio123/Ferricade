// The mock API in the browser: a service worker serves the contract from a
// MockDB. Only main.tsx imports this, and only behind import.meta.env checks,
// so the production build contains none of it.
import { setupWorker } from 'msw/browser'
import { readMockConfig } from './config'
import { createMockControls } from './controls'
import { createMockDB } from './db'
import { createMockApi } from './handlers'

/** How often a random device goes online or offline in dev. */
export const ACTIVITY_INTERVAL_MS = 20_000

/**
 * Starts the worker with the switches in `search` (the page's query string).
 * `activity` is the interval of the random online/offline toggling: pass 0 (or
 * run under test) for none.
 */
export async function startMockWorker(search: string, activity = ACTIVITY_INTERVAL_MS) {
  const config = readMockConfig(search)
  // Saved preferences survive a reload in this tab (like the real server).
  const db = createMockDB(config.size, {
    preferencesStore: sessionStorage,
    sessionSettingsStore: sessionStorage,
  })
  const { handlers, env } = createMockApi(db, config)
  const worker = setupWorker(...handlers)
  // Opening a rustdesk:// link fires beforeunload although the page stays.
  // MSW's own beforeunload listener tells its worker the page closed, after
  // which every request misses the mock. Registered first, this one stops it;
  // a real reload starts a new worker client anyway.
  window.addEventListener('beforeunload', (event) => event.stopImmediatePropagation())
  await worker.start({
    onUnhandledRequest: 'bypass',
    serviceWorker: { url: '/mockServiceWorker.js' },
    quiet: true,
  })
  if (activity > 0) setInterval(() => db.toggleRandomDeviceOnline(), activity)
  // For the Playwright flows (e2e/): end the session, drop the stream, change a device.
  window.__ferricadeMock = createMockControls(env)
  return { worker, db, config }
}
