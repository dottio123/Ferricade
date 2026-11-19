import { defineConfig, devices } from '@playwright/test'
import { ADMIN_URL } from './e2e-live/support/stack.ts'

// The live suite (Phase 1b gate C1): the production UI served by a real
// ferricade with Postgres, driven like an admin would, with rdsim as the fleet.
// `npm run e2e:live` (e2e-live/run.ts) starts the stack first. The specs share
// one database and run in order, so one worker.
export default defineConfig({
  testDir: 'e2e-live',
  outputDir: 'test-results-live',
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-live' }]]
    : 'list',
  use: {
    baseURL: ADMIN_URL,
    trace: 'retain-on-failure',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--host-resolver-rules=MAP dex 127.0.0.1'],
        },
      },
    },
  ],
})
