// Ruling W2: the mock API is only in the mock build. The production build
// (web/dist, embedded in the Go binary) must contain no MSW, no worker script
// and no fixtures, and no dev-only page. `npm run e2e` runs `npm run build`
// first, so a stale dist cannot pass.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const WEB = fileURLToPath(new URL('../', import.meta.url))
const DIST = join(WEB, 'dist')
const CHECK = join(WEB, 'scripts/check-dist.mjs')

function checkDist(dir: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [CHECK, dir], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, output }
  } catch (err) {
    const e = err as { status: number; stderr: string }
    return { code: e.status, output: e.stderr }
  }
}

test.describe('the production build', () => {
  test('exists (run npm run build before npm run e2e)', () => {
    expect(existsSync(join(DIST, 'index.html')), 'web/dist/index.html').toBe(true)
  })

  test('passes check-dist: no MSW, no worker script, no fixtures, CSP-safe', () => {
    expect(checkDist(DIST)).toEqual({ code: 0, output: 'check-dist ok\n' })
  })

  test('has no dev-only page', () => {
    // Every dev-only page carries data-dev-only (src/routes/dev/kitchen-sink.tsx).
    const js = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'))
    for (const f of js) {
      expect(readFileSync(join(DIST, 'assets', f), 'utf8'), f).not.toContain('data-dev-only')
    }
  })
})

test('loads each page on demand: the entry script stays under 500 kB', () => {
  // The entry is the one module script index.html loads; route code (charts,
  // drag and drop, the wizard) is split into chunks fetched when a page opens.
  const html = readFileSync(join(DIST, 'index.html'), 'utf8')
  const entry = /<script type="module" crossorigin src="\/(assets\/[^"]+\.js)">/.exec(html)?.[1]
  expect(entry, 'entry script in index.html').toBeTruthy()
  const size = readFileSync(join(DIST, entry!)).length
  expect(size, `${entry} is ${Math.round(size / 1024)} kB`).toBeLessThan(500 * 1024)
  const chunks = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'))
  expect(chunks.length, 'route chunks').toBeGreaterThan(5)
})

test('route files export only Route, so each page can be split', () => {
  // TanStack Router's autoCodeSplitting skips a route file that exports
  // anything else, and the whole page lands in the entry chunk again.
  const routes = join(WEB, 'src/routes')
  const files = readdirSync(routes, { recursive: true, encoding: 'utf8' }).filter(
    (f) => f.endsWith('.tsx') && !f.endsWith('__root.tsx'),
  )
  for (const f of files) {
    const source = readFileSync(join(routes, f), 'utf8')
    const exported = [...source.matchAll(/^export (?:const|function|class|let) (\w+)/gm)].map(
      (m) => m[1],
    )
    expect(exported, `${f}: export only Route (move shared code to src/components)`).toEqual([
      'Route',
    ])
  }
})

test('check-dist rejects the mock build (so it would catch mocks in dist)', () => {
  expect(checkDist(join(WEB, 'dist-mock')).code).toBe(1)
})

test('the mock build has the dev-only marker (so the check above would see it)', () => {
  const js = readdirSync(join(WEB, 'dist-mock', 'assets')).filter((f) => f.endsWith('.js'))
  const marked = js.filter((f) =>
    readFileSync(join(WEB, 'dist-mock', 'assets', f), 'utf8').includes('data-dev-only'),
  )
  expect(marked.length).toBeGreaterThan(0)
})
