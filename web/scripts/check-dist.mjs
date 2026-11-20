// Fails the build if the output would violate the CSP
// (default-src 'self'): no data: URLs in assets, no inline <script>/<style>;
// if index.html lacks the CSP nonce placeholder ferricade fills in on every
// response (Ruling F5: exactly once, in <meta name="csp-nonce">); or if it carries the mock API (MSW, its worker script, the mock fixtures)
// or a dev-only page, which are for development and tests only.
//   node scripts/check-dist.mjs [dir]    dir defaults to dist/
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = process.argv[2] ?? fileURLToPath(new URL('../dist/', import.meta.url))
const problems = []

// Text that only the mock API's code contains: MSW's log prefix, the worker
// script's name, a value from the mock fixtures (src/mocks/config.ts), the
// Playwright controls (src/mocks/controls.ts) and the ?mock-session= switch.
const MOCK_MARKERS = [
  /\[MSW\]/,
  /mockServiceWorker/,
  /mock-setup-token/,
  /__ferricadeMock/,
  /mock-session/,
]

// The attribute every dev-only page (src/routes/dev/) carries: the production
// build drops those pages, so it must not contain it.
const DEV_ONLY_MARKER = /data-dev-only/

function* walk(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* walk(join(dir, entry.name), prefix + entry.name + '/')
    else yield prefix + entry.name
  }
}

for (const name of walk(dist)) {
  if (name.endsWith('mockServiceWorker.js')) problems.push(`${name} is in the build (mock API)`)
  if (!/\.(css|js|html)$/.test(name)) continue
  const text = readFileSync(join(dist, name), 'utf8')
  if (/data:[a-z]+\/[a-z0-9.+-]+[;,]/i.test(text)) problems.push(`${name} contains a data: URL`)
  for (const marker of MOCK_MARKERS) {
    if (marker.test(text)) problems.push(`${name} contains mock API code (matches ${marker})`)
  }
  if (DEV_ONLY_MARKER.test(text)) problems.push(`${name} contains a dev-only page (data-dev-only)`)
}

for (const required of ['manifest.json', 'sw.js', 'favicon.svg', 'favicon.ico']) {
  try {
    readFileSync(join(dist, required))
  } catch {
    problems.push(`${required} is missing from the build`)
  }
}

const html = readFileSync(join(dist, 'index.html'), 'utf8')
if (!/<link\s+rel="manifest"\s+href="\/manifest\.json"\s*\/?\s*>/i.test(html))
  problems.push('index.html has no <link rel="manifest" href="/manifest.json">')
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc=/.test(m[1] ?? '') || (m[2] ?? '').trim())
    problems.push('index.html has an inline <script>')
}
if (/<style\b/i.test(html)) problems.push('index.html has an inline <style>')
const NONCE_PLACEHOLDER = '__FERRICADE_CSP_NONCE__'
const placeholders = html.split(NONCE_PLACEHOLDER).length - 1
if (
  placeholders !== 1 ||
  !/<meta\s+name="csp-nonce"\s+content="__FERRICADE_CSP_NONCE__"\s*\/?>/.test(html)
)
  problems.push(
    `index.html must carry ${NONCE_PLACEHOLDER} once, in <meta name="csp-nonce"> (found ${placeholders})`,
  )
if (/\sstyle=/i.test(html)) problems.push('index.html has an inline style attribute')

if (problems.length) {
  console.error('check-dist failed:\n  ' + problems.join('\n  '))
  process.exit(1)
}
console.log('check-dist ok')
