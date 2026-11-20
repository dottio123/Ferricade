// The ?next= of the sign-in pages: where to go after signing in. It comes from
// the URL, so anyone can craft it; only a path of this app is followed, never
// another origin (an open redirect would make a phishing link look like ours).

const BASE = 'http://ferricade.invalid'

// Not worth returning to: the sign-in steps themselves (a loop) and the wizard.
const AUTH_PAGES = new Set(['/sign-in', '/sign-in/totp', '/enroll-totp', '/first-run'])
// The backend's paths on the admin listener: a reload there returns JSON.
const BACKEND = /^\/(admin\/api|setup|api|healthz)(\/|$)/

/** A same-origin path to go to after signing in; "/" when `raw` is anything else. */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/'
  // Browsers read "//host", "/\host" and those with tabs or newlines inside as another origin.
  if (
    startsAsAnotherOrigin(raw) ||
    hasControlCharacter(raw) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(raw.split(/[?#]/, 1)[0] ?? '')
  )
    return '/'
  let url: URL
  try {
    url = new URL(raw, BASE)
  } catch {
    return '/'
  }
  if (url.origin !== BASE) return '/'
  // Dot segments collapse on parsing ("/a/..//host" is "//host"), so the result is checked too.
  if (startsAsAnotherOrigin(url.pathname)) return '/'
  if (AUTH_PAGES.has(url.pathname) || BACKEND.test(url.pathname)) return '/'
  return url.pathname + url.search + url.hash
}

/** The ?next= for the page at `href` (path and query): left out when it is "/" or not safe. */
export function nextFor(href: string): string | undefined {
  const next = safeNext(href)
  return next === '/' ? undefined : next
}

function startsAsAnotherOrigin(path: string): boolean {
  return /^\/[\\/]/.test(path)
}

function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}
