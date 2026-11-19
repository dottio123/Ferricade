import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { configDefaults } from 'vitest/config'

/**
 * Serves MSW's worker script at /mockServiceWorker.js for the mock API, from
 * node_modules, so no copy of it sits in the source tree (a public/ copy would
 * end up in the production build). Only the dev server and `vite build --mode
 * mock` get it; `npm run build` never does (scripts/check-dist.mjs checks).
 */
function mockServiceWorker(): Plugin {
  const source = () =>
    readFileSync(createRequire(import.meta.url).resolve('msw/mockServiceWorker.js'), 'utf8')
  return {
    name: 'ferricade-mock-service-worker',
    configureServer(server) {
      server.middlewares.use('/mockServiceWorker.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(source())
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'mockServiceWorker.js', source: source() })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'FERRICADE_')
  // ferricade checks Origin against PUBLIC_URL on state-changing requests, so the
  // dev proxy presents the target's own origin (the target runs with DEV_INSECURE=1).
  // That is why FERRICADE_URL must equal ferricade's PUBLIC_URL.
  function liveProxy() {
    const target = process.env.FERRICADE_URL ?? env.FERRICADE_URL
    if (!target) {
      throw new Error(
        'dev:live: set FERRICADE_URL to your ferricade PUBLIC_URL, e.g. http://203.0.113.10:21120 ' +
          '(in the environment or web/.env.local). It must equal PUBLIC_URL because ferricade checks the Origin header against it.',
      )
    }
    const proxied = { target, changeOrigin: true, headers: { Origin: new URL(target).origin } }
    return {
      '/admin/api': proxied,
      '/setup': proxied,
      '/api': proxied,
      '/healthz': proxied,
    }
  }

  // The mock API runs in the dev server and in `vite build --mode mock` (e2e, shots),
  // never in the live proxy or production.
  const mocks = mode === 'mock' || (command === 'serve' && mode !== 'live')

  return {
    plugins: [
      // File-based routes: src/routes/** generates src/routeTree.gen.ts (committed,
      // so typecheck works without a build; never edit it by hand).
      tanstackRouter({
        target: 'react',
        routesDirectory: 'src/routes',
        generatedRouteTree: 'src/routeTree.gen.ts',
        quoteStyle: 'single',
        semicolons: false,
        // Each route's component is its own chunk, fetched when the page opens:
        // the charts and drag and drop no longer load with the sign-in page.
        // Builds only (production and the e2e mock build): in Vitest and the
        // dev server a lazy route only slows the first render.
        autoCodeSplitting: command === 'build',
      }),
      react(),
      tailwindcss(),
      ...(mocks ? [mockServiceWorker()] : []),
    ],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, 'src') },
    },
    build: {
      // The mock build never shares dist/ (embedded in the Go binary), even when
      // run by hand without --outDir.
      outDir: mode === 'mock' ? 'dist-mock' : 'dist',
      emptyOutDir: mode === 'mock', // false keeps dist/.gitkeep for the Go embed
      assetsDir: 'assets',
      assetsInlineLimit: 0, // CSP default-src 'self' blocks data: URLs
      modulePreload: { polyfill: false }, // CSP forbids inline scripts
    },
    server: {
      // Tests read the API contract; the About dialog reads CHANGELOG.md.
      fs: {
        allow: [
          import.meta.dirname,
          path.resolve(import.meta.dirname, '../internal/adminapi'),
          // Vitest's module runner loads raw imports directly; the dev server gets only the file.
          path.resolve(import.meta.dirname, mode === 'test' ? '..' : '../CHANGELOG.md'),
        ],
      },
      ...(mode === 'live' ? { proxy: liveProxy() } : {}),
    },
    test: {
      environment: 'jsdom',
      environmentOptions: { jsdom: { url: 'http://ferricade.test/' } },
      setupFiles: ['./vitest.setup.ts'],
      // e2e/ is Playwright's (npm run e2e).
      exclude: [...configDefaults.exclude, 'e2e/**', 'e2e-live/**'],
      css: false,
    },
  }
})
