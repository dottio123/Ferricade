// npm run shots: screenshots of every route (mock "medium") in the dark and
// light themes at 1440×900 and 390×844, written to web/shots/<route>-<theme>-<width>.png.
// They are for the user's visual reviews; agents do not open them.
// The theme is the browser's prefers-color-scheme, which the app follows by default.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { ROUTES, slug } from '../e2e/support/routes.ts'
import { serveDist } from '../e2e/support/server.ts'

const OUT = fileURLToPath(new URL('../shots/', import.meta.url))
const THEMES = ['dark', 'light'] as const
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]

mkdirSync(OUT, { recursive: true })
const server = await serveDist()
const browser = await chromium.launch()
let written = 0
try {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport, colorScheme: theme })
      const page = await context.newPage()
      let deviceId = ''
      for (const route of ROUTES) {
        let path = route.path
        if (route.id) {
          if (!deviceId) {
            await page.goto(`${server.url}/devices`)
            await page.waitForFunction(() => window.__ferricadeMock !== undefined)
            deviceId = await page.evaluate(() => window.__ferricadeMock!.approvedDeviceId())
          }
          path = path.replace('$id', deviceId)
        }
        const query = ['mock=medium', route.query].filter(Boolean).join('&')
        await page.goto(`${server.url}${path}?${query}`)
        await page
          .getByRole('heading', { level: 1, name: route.heading, exact: true })
          .waitFor({ timeout: 15_000 })
        await page.waitForLoadState('networkidle').catch(() => {})
        const file = `${OUT}${slug(route.path)}-${theme}-${viewport.width}.png`
        await page.screenshot({ path: file, fullPage: true })
        written++
      }
      await context.close()
    }
  }
} finally {
  await browser.close()
  await server.close()
}
console.log(`shots: wrote ${written} screenshots to ${OUT}`)
