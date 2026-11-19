// A small static server for the mock build (dist-mock), with ferricade's own
// security headers, so every Playwright flow runs under the production CSP.
// It serves files like internal/adminapi/ui.go does: a file of the build at its
// path, index.html for any other UI path (and for /index.html), with a fresh
// style nonce in its csp-nonce meta and its CSP (Ruling F5). Backend paths (/admin/api, /setup,
// /api, /healthz) answer 404 JSON: in the mock build MSW's service worker
// answers them, so a request that reaches this server was not mocked.
import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = fileURLToPath(new URL('../../', import.meta.url))

/**
 * The Content-Security-Policy ferricade sends, read from the Go source so this
 * server cannot drift from it.
 */
export function ferricadeCSP(): string {
  const go = readFileSync(join(WEB, '../internal/adminapi/middleware.go'), 'utf8')
  const m = /contentSecurityPolicy\s*=\s*"([^"]+)"/.exec(go)
  if (!m?.[1]) throw new Error('contentSecurityPolicy not found in internal/adminapi/middleware.go')
  return m[1]
}

/**
 * The CSP of an index.html response: ferricade's with a style-src for nonce
 * after default-src, as internal/adminapi/ui.go styleNonceCSP builds it. Should
 * default-src change, nothing is inserted (as in Go) and csp.spec fails.
 */
export function ferricadeIndexCSP(nonce: string): string {
  const head = "default-src 'self'; "
  return ferricadeCSP().replace(head, `${head}style-src 'self' 'nonce-${nonce}'; `)
}

/** The text in web/index.html's csp-nonce meta that ferricade replaces. */
const NONCE_PLACEHOLDER = '__FERRICADE_CSP_NONCE__'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const BACKEND = /^\/(admin\/api|setup|api|healthz)(\/|$)/

export interface StaticServer {
  url: string
  close(): Promise<void>
}

export async function serveDist(
  options: { dir?: string; port?: number; host?: string } = {},
): Promise<StaticServer> {
  const root = normalize(options.dir ?? join(WEB, 'dist-mock'))
  const csp = ferricadeCSP()
  const index = readFileSync(join(root, 'index.html'), 'utf8')

  const server: Server = createServer((req, res) => {
    // The headers of internal/adminapi/middleware.go securityHeaders (minus HSTS: plain HTTP).
    res.setHeader('Content-Security-Policy', csp)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')

    let path: string
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    } catch {
      // A malformed escape ("/%E0%A4%A"): thrown here, it would end the server.
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('bad request path')
      return
    }
    if (BACKEND.test(path)) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ error: { code: 'not_found', message: `not mocked: ${path}` } }))
      return
    }
    const file = normalize(join(root, path))
    if (path !== '/index.html' && file.startsWith(root + sep) && isFile(file)) {
      const immutable = path.startsWith('/assets/')
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      })
      res.end(readFileSync(file))
      return
    }
    const nonce = randomBytes(16).toString('base64')
    res.writeHead(200, {
      'Content-Type': TYPES['.html']!,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': ferricadeIndexCSP(nonce),
    })
    res.end(index.replaceAll(NONCE_PLACEHOLDER, nonce))
  })

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve),
  )
  const { port } = server.address() as AddressInfo
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
