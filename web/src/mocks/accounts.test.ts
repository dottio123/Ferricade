import { describe, expect, it } from 'vitest'
import { checkServer, patchServer } from './accounts'
import { createMockDB } from './db'

describe('mock server client API address', () => {
  it('rejects values the server rejects with bad_request', () => {
    const db = createMockDB('small')
    const owner = db.users[0]!
    for (const api_url of [
      'http://api.example.com',
      'https://api.example.com/path',
      'https://api.example.com/./',
      'https://api.example.com?x=1',
      'https://api.example.com?',
      'https://api.example.com#fragment',
      'https://api.example.com#',
      'https://user:pass@api.example.com',
      'https://api.example.com:21114',
      'https://api.example.com:garbage',
      'not a URL',
    ]) {
      const result = patchServer(db, { api_url }, owner)
      expect(result, api_url).toMatchObject({ ok: false, status: 400, code: 'bad_request' })
    }
    expect(db.server?.api_url).toBe('')
  })

  it('trims one slash and uses the client API host and port in setup checks', () => {
    const db = createMockDB('small')
    const owner = db.users[0]!
    const saved = patchServer(db, { api_url: 'https://api.example.com:8443/' }, owner)
    expect(saved).toMatchObject({ ok: true, value: { api_url: 'https://api.example.com:8443' } })
    expect(checkServer(db.server!).find((check) => check.name === 'client-api')?.target).toBe(
      'api.example.com:8443',
    )
    expect(
      checkServer({ ...db.server!, api_url: 'https://api.example.com' }).find(
        (check) => check.name === 'client-api',
      )?.target,
    ).toBe('api.example.com:443')
    expect(
      checkServer({ ...db.server!, api_url: 'https://[2001:db8::1]:8443' }).find(
        (check) => check.name === 'client-api',
      )?.target,
    ).toBe('[2001:db8::1]:8443')
  })
})

describe('mock server connect link setting', () => {
  it('stores and audits changes to links_include_server', () => {
    const db = createMockDB('small')
    const owner = db.users[0]!
    const result = patchServer(db, { links_include_server: false }, owner)
    expect(result).toMatchObject({ ok: true, value: { links_include_server: false } })
    expect(db.auditLog.findLast((event) => event.action === 'server.updated')?.details).toEqual({
      before: { links_include_server: true },
      after: { links_include_server: false },
    })
  })
})
