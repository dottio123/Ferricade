// @vitest-environment node
// check-dist.mjs must fail a production build that contains the mock API.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, 'check-dist.mjs')
const roots = []

const NONCE_META = '<meta name="csp-nonce" content="__FERRICADE_CSP_NONCE__" />'

/** A minimal conforming build, plus whatever extra files the case adds. */
function build(extra = {}, head = `${NONCE_META}<link rel="manifest" href="/manifest.json" />`) {
  const dir = mkdtempSync(join(tmpdir(), 'check-dist-'))
  roots.push(dir)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><html><head>${head}</head><body><div id="root"></div>` +
      '<script type="module" src="/assets/index.js"></script></body></html>',
  )
  writeFileSync(join(dir, 'assets', 'index.js'), 'console.log("app")')
  writeFileSync(join(dir, 'manifest.json'), '{}')
  writeFileSync(join(dir, 'sw.js'), "self.addEventListener('fetch', () => {})")
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>')
  writeFileSync(join(dir, 'favicon.ico'), 'ico')
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content)
  return dir
}

function check(dir) {
  const r = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('check-dist', () => {
  it('passes a build without mock code', () => {
    expect(check(build())).toMatchObject({ code: 0 })
  })

  it.each(['manifest.json', 'sw.js'])('fails when %s is missing', (name) => {
    const dir = build()
    rmSync(join(dir, name))
    const r = check(dir)
    expect(r.code).toBe(1)
    expect(r.out).toContain(name)
  })

  it.each(['favicon.svg', 'favicon.ico'])('fails when %s is missing', (name) => {
    const dir = build()
    rmSync(join(dir, name))
    const r = check(dir)
    expect(r.code).toBe(1)
    expect(r.out).toContain(name)
  })

  it('fails when index.html has no manifest link', () => {
    const r = check(build({}, NONCE_META))
    expect(r.code).toBe(1)
    expect(r.out).toContain('manifest')
  })

  it('fails when mockServiceWorker.js is in the build', () => {
    const r = check(build({ 'mockServiceWorker.js': '// worker' }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('mockServiceWorker.js')
  })

  it.each([
    ['MSW itself', 'console.warn("[MSW] Mocking enabled")'],
    ['the worker script URL', 'navigator.serviceWorker.register("/mockServiceWorker.js")'],
    ['the mock fixtures', 'const t = "mock-setup-token"'],
    ['the mock controls', 'window.__ferricadeMock = controls'],
    ['the mock session switch', 'params.get("mock-session")'],
  ])('fails when a script contains %s', (_, js) => {
    const r = check(build({ 'assets/mocks.js': js }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('mock')
  })

  // Ruling F5: ferricade replaces the placeholder with each response's nonce.
  it.each([
    ['is missing', ''],
    ['is not in the csp-nonce meta', '<meta name="other" content="__FERRICADE_CSP_NONCE__" />'],
    ['is there twice', NONCE_META + NONCE_META],
  ])('fails when the CSP nonce placeholder %s', (_, head) => {
    const r = check(build({}, head))
    expect(r.code).toBe(1)
    expect(r.out).toContain('csp-nonce')
  })

  it.each([
    ['an inline <style>', '<style nonce="__FERRICADE_CSP_NONCE__">p{}</style>'],
    ['an inline <script>', '<script nonce="__FERRICADE_CSP_NONCE__">1</script>'],
    ['a style attribute', '<meta name="x" style="color:red" />'],
  ])('fails when index.html has %s, nonce or not', (_, extra) => {
    const r = check(build({}, NONCE_META + extra))
    expect(r.code).toBe(1)
    expect(r.out).toContain('index.html has an inline')
  })

  it('fails when a script contains a data: URL', () => {
    const r = check(build({ 'assets/img.js': 'const u = "data:image/png;base64,AAAA"' }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('data: URL')
  })

  it('fails when a script contains a dev-only page', () => {
    const js =
      'jsx("main",{"data-dev-only":"kitchen-sink",children:jsx("h1",{children:"Kitchen sink"})})'
    const r = check(build({ 'assets/index-dev.js': js }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('dev-only page')
  })
})
