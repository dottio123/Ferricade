import { describe, expect, it } from 'vitest'
import { nextFor, safeNext } from './next'

describe('safeNext', () => {
  it.each([
    ['/devices', '/devices'],
    ['/devices?state=pending', '/devices?state=pending'],
    ['/devices/6f1c?tab=audit#notes', '/devices/6f1c?tab=audit#notes'],
    ['/account', '/account'],
  ])('keeps the same-origin path %s', (raw, want) => {
    expect(safeNext(raw)).toBe(want)
  })

  it.each([
    ['an absolute URL', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example/devices'],
    ['a backslash URL (browsers read it as //)', '/\\evil.example'],
    ['a tab inside //', '/\t/evil.example'],
    ['dot segments that normalise to //', '/a/..//evil.example'],
    ['encoded dot segments that normalise to //', '/%2e%2e//evil.example'],
    ['dot segments with a path and query after //', '/devices/..//evil.example/x?y=1'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a relative path', 'devices'],
    ['an empty string', ''],
    ['a number', 42],
    ['nothing', undefined],
    ['a sign-in page (a loop)', '/sign-in?next=/devices'],
    ['the TOTP step', '/sign-in/totp'],
    ['the enrollment page', '/enroll-totp'],
    ['the setup wizard', '/first-run'],
    ['a backend path', '/admin/api/v1/auth/me'],
    ['the setup API', '/setup/status'],
    ['the client API', '/api/heartbeat'],
    ['the health check', '/healthz'],
    ['encoded tab', '/%09/x'],
    ['encoded newline', '/%0a/x'],
    ['encoded carriage return', '/%0D/x'],
    ['encoded DEL', '/%7f/x'],
    ['encoded tab before dot segments', '/a/%09/..//x'],
  ])('falls back to / for %s', (_, raw) => {
    expect(safeNext(raw)).toBe('/')
  })
})

describe('nextFor', () => {
  it('is the page to come back to', () => {
    expect(nextFor('/devices?state=pending')).toBe('/devices?state=pending')
  })

  it('is left out for the command center and for pages that are not worth returning to', () => {
    expect(nextFor('/')).toBeUndefined()
    expect(nextFor('/sign-in')).toBeUndefined()
    expect(nextFor('//evil.example')).toBeUndefined()
  })
})
