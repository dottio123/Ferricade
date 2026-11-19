import { defineConfig, devices } from '@playwright/test'

// The flows run against the mock build (npm run build:mock → dist-mock/), served
// with ferricade's security headers by e2e/support/serve.ts. `npm run e2e` builds
// it first, after the production build (dist/), which never contains the mock and
// which e2e/production-build.spec.ts checks.
const PORT = 4173

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  // Two browsers at a time. The default (half the CPU cores, 4 here) starved the
  // pages of CPU: about one test in 60–120 timed out (a page that never reached
  // "load", a heading not shown within 5 s). With 2: 360 of 360 passed, no slower.
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/support/serve.ts',
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    stdout: 'ignore',
  },
})
