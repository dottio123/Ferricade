// npm run e2e:live: builds and starts a fresh ferricade + Postgres stack
// (support/stack.ts), runs the live specs against it, then removes the stack
// and its volumes. E2E_LIVE_KEEP=1 leaves it running for a rerun or a look;
// `npx playwright test -c playwright.live.config.ts` then reuses it.
// Extra arguments go to Playwright.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_URL, compose } from './support/stack.ts'

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function waitForAdmin(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`${ADMIN_URL}/`)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`ferricade did not answer at ${ADMIN_URL}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

// A throwaway key for a throwaway database; it only encrypts this run's TOTP secret.
process.env.SECRET_KEY = randomBytes(32).toString('base64')

let status = 1
try {
  compose(['down', '-v', '--remove-orphans'])
  console.log(
    'e2e:live: building and starting ferricade + Postgres (Compose project ferricade-e2e)',
  )
  compose(['up', '-d', '--build', '--wait', 'db', 'app'])
  await waitForAdmin(120_000)
  const run = spawnSync(
    process.execPath,
    [
      path.join(web, 'node_modules/@playwright/test/cli.js'),
      'test',
      '-c',
      'playwright.live.config.ts',
      ...process.argv.slice(2),
    ],
    { cwd: web, stdio: 'inherit', env: process.env },
  )
  status = run.status ?? 1
} finally {
  if (status !== 0) {
    try {
      console.log(compose(['logs', '--no-color', '--tail', '200', 'app']))
    } catch {
      // the stack may not have started
    }
  }
  if (process.env.E2E_LIVE_KEEP === '1') {
    console.log(`e2e:live: stack left running at ${ADMIN_URL} (E2E_LIVE_KEEP=1)`)
  } else {
    compose(['down', '-v', '--remove-orphans'])
  }
}
process.exit(status)
