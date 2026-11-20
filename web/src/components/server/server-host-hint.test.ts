import { describe, expect, it } from 'vitest'
import { serverHostWarning } from './server-host-hint'

describe('serverHostWarning', () => {
  it.each(['hbbs', 'hbbs:21116', 'app', 'localhost', '127.0.0.1', '::1'])(
    'warns for %s',
    (host) => {
      const name = host === 'hbbs:21116' ? 'hbbs' : host
      expect(serverHostWarning(host)).toBe(
        `Clients on other machines can't reach ${name}. Use this server's LAN IP or DNS name.`,
      )
    },
  )

  it.each(['172.16.1.154', '172.16.1.154:21116', 'rd.example.com', '[2001:db8::1]'])(
    'does not warn for %s',
    (host) => {
      expect(serverHostWarning(host)).toBeNull()
    },
  )
})
