// @vitest-environment node
// The guardrails in eslint.config.js (Ruling F2): mock code, MSW and
// openapi-fetch stay where they belong, and only the API client, the live
// stream, the mock and the tests touch the network or browser storage.
// Each case lints a snippet as if it were the named file, with the real config.
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

const eslint = new ESLint({ cwd: import.meta.dirname })

/** The rule ids reported for `code` linted as `filePath` (relative to web/). */
async function rules(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages.map((m) => m.ruleId ?? m.message)
}

const PAGE = 'src/routes/_app/devices/index.tsx'

beforeAll(async () => {
  await rules(PAGE, 'void 0\n')
}, 30_000)

describe('no-restricted-imports', () => {
  it.each([
    ["import { DEMO } from '../../mocks/config'\nvoid DEMO\n"],
    ["import { DEMO } from '@/mocks/config'\nvoid DEMO\n"],
    ["import type { Env } from '../../mocks/route'\nexport type E = Env\n"],
    ["import { http } from 'msw'\nvoid http\n"],
    ["import { setupServer } from 'msw/node'\nvoid setupServer\n"],
    ["import createClient from 'openapi-fetch'\nvoid createClient\n"],
  ])('reports %s in a page', async (code) => {
    expect(await rules(PAGE, code)).toContain('no-restricted-imports')
  })

  it('reports a dynamic import of the mock in a page', async () => {
    expect(await rules(PAGE, "void import('../../mocks/browser')\n")).toContain(
      'no-restricted-syntax',
    )
  })

  it('says why', async () => {
    const [mocks] = await eslint.lintText("import { http } from 'msw'\nvoid http\n", {
      filePath: PAGE,
    })
    expect(mocks.messages[0].message).toMatch(/mock data never ships/i)
    const [client] = await eslint.lintText("import c from 'openapi-fetch'\nvoid c\n", {
      filePath: PAGE,
    })
    expect(client.messages[0].message).toMatch(/use api from src\/api\/client/i)
  })

  it.each([
    ['src/mocks/handlers.ts', "import { http } from 'msw'\nvoid http\n"],
    ['src/mocks/handlers.ts', "import { DEMO } from './mocks/config'\nvoid DEMO\n"],
    ['src/main.tsx', "void import('./mocks/browser')\n"],
    [
      'src/router.test.tsx',
      "import { createMockApi } from './mocks/handlers'\nvoid createMockApi\n",
    ],
    ['src/api/client.test.ts', "import { http } from 'msw'\nvoid http\n"],
    ['vitest.setup.ts', "import { http } from 'msw'\nvoid http\n"],
    [
      'e2e/flow.spec.ts',
      "import type { MockControls } from '../src/mocks/controls'\nexport type M = MockControls\n",
    ],
    ['src/api/client.ts', "import createClient from 'openapi-fetch'\nvoid createClient\n"],
  ])('allows it in %s', async (file, code) => {
    expect(await rules(file, code)).toEqual([])
  })

  it('still forbids openapi-fetch in the mock and the tests outside src/api', async () => {
    const code = "import c from 'openapi-fetch'\nvoid c\n"
    expect(await rules('src/mocks/handlers.ts', code)).toContain('no-restricted-imports')
    expect(await rules('src/router.test.tsx', code)).toContain('no-restricted-imports')
  })

  it('still forbids the mock in src/api outside its tests', async () => {
    expect(await rules('src/api/client.ts', "import { http } from 'msw'\nvoid http\n")).toContain(
      'no-restricted-imports',
    )
  })
})

describe('no-restricted-globals and no-restricted-properties', () => {
  it.each([
    ["void fetch('/admin/api/v1/devices')\n", 'no-restricted-globals'],
    ['void new XMLHttpRequest()\n', 'no-restricted-globals'],
    ["void new EventSource('/admin/api/v1/events')\n", 'no-restricted-globals'],
    ["void localStorage.getItem('x')\n", 'no-restricted-globals'],
    ["void sessionStorage.getItem('x')\n", 'no-restricted-globals'],
    ["void indexedDB.open('x')\n", 'no-restricted-globals'],
    ["void window.fetch('/x')\n", 'no-restricted-properties'],
    ["void globalThis.fetch('/x')\n", 'no-restricted-properties'],
    ["void window.localStorage.getItem('x')\n", 'no-restricted-properties'],
    ['void globalThis.EventSource\n', 'no-restricted-properties'],
  ])('reports %s in a page', async (code, rule) => {
    expect(await rules(PAGE, code)).toContain(rule)
  })

  it.each([
    'src/api/client.ts',
    'src/live/connection.ts',
    'src/mocks/browser.ts',
    'src/auth/session.test.ts',
    'src/router.test.tsx',
    'vitest.setup.ts',
    'e2e/support/server.ts',
    'scripts/shots.ts',
  ])('allows them in %s', async (file) => {
    const code =
      "void fetch('/x')\nvoid globalThis.fetch('/x')\nvoid localStorage.length\nvoid new EventSource('/e')\n"
    expect(await rules(file, code)).toEqual([])
  })
})

describe('the appearance cache (B1)', () => {
  const STORAGE =
    "void localStorage.getItem('ferricade-appearance')\nvoid document.documentElement\n"

  it('lets src/lib/appearance.ts use localStorage, and nothing else of the list', async () => {
    expect(await rules('src/lib/appearance.ts', STORAGE)).toEqual([])
    expect(await rules('src/lib/appearance.ts', "void fetch('/x')\n")).toContain(
      'no-restricted-globals',
    )
    expect(await rules('src/lib/appearance.ts', 'void sessionStorage.length\n')).toContain(
      'no-restricted-globals',
    )
  })

  it('lets the app shell remember its non-sensitive sidebar mode only', async () => {
    expect(await rules('src/routes/_app.tsx', STORAGE)).toEqual([])
    expect(await rules('src/routes/_app.tsx', "void fetch('/x')\n")).toContain(
      'no-restricted-globals',
    )
    expect(await rules('src/routes/_app.tsx', 'void sessionStorage.length\n')).toContain(
      'no-restricted-globals',
    )
  })

  it('lints public/theme.js as a browser script that may read storage but not the network', async () => {
    expect(await rules('public/theme.js', STORAGE)).toEqual([])
    expect(await rules('public/theme.js', "void fetch('/x')\n")).toContain('no-restricted-globals')
  })

  it('lets src/auth/intro-flag.ts use sessionStorage only, and nothing else of the list', async () => {
    expect(
      await rules('src/auth/intro-flag.ts', "void window.sessionStorage.getItem('x')\n"),
    ).toEqual([])
    expect(await rules('src/auth/intro-flag.ts', "void localStorage.getItem('x')\n")).toContain(
      'no-restricted-globals',
    )
    expect(await rules('src/auth/intro-flag.ts', "void fetch('/x')\n")).toContain(
      'no-restricted-globals',
    )
  })
})

describe('the service worker', () => {
  it('allows navigation fetch while banning browser storage and caches', async () => {
    expect(
      await rules(
        'public/sw.js',
        "self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)))\nvoid self.clients\n",
      ),
    ).toEqual([])
    expect(await rules('public/sw.js', 'void localStorage.length\n')).toContain(
      'no-restricted-globals',
    )
    expect(await rules('public/sw.js', "void caches.open('x')\n")).toContain(
      'no-restricted-globals',
    )
    expect(await rules('public/sw.js', 'void self.caches\n')).toContain('no-restricted-properties')
  })
})
