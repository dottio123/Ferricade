import { describe, expect, it } from 'vitest'
import { checkHint } from './check-hint'

describe('checkHint', () => {
  it('explains DNS failures', () => {
    expect(checkHint('dns', '192.0.2.1:21116', 'rd.example.com:21116')).toBe(
      'The name could not be resolved. Check the host in Server settings and your DNS.',
    )
  })

  it('explains refused connections with the address', () => {
    expect(checkHint('refused', '192.0.2.1:21117', 'relay.example.com:21117')).toBe(
      'Nothing accepts connections at 192.0.2.1:21117. Is that the machine running the RustDesk server, with its ports published?',
    )
  })

  it('explains timeouts with the address', () => {
    expect(checkHint('timeout', '192.0.2.1:21116', 'rd.example.com:21116')).toBe(
      "No answer from 192.0.2.1:21116 within 3 seconds. Usually a firewall, a missing port forward, or a router without NAT loopback. On Docker Desktop, this check can fail for the machine's own LAN address even when other machines reach it; test from another machine.",
    )
  })

  it('does not add the Docker Desktop note to refused connections', () => {
    expect(checkHint('refused', '192.0.2.1:21116', 'rd.example.com:21116')).not.toContain(
      'Docker Desktop',
    )
  })

  it('explains unreachable networks with the address', () => {
    expect(checkHint('unreachable', '192.0.2.1:21116', 'rd.example.com:21116')).toBe(
      'The network cannot reach 192.0.2.1:21116. Check routing or VPN.',
    )
  })

  it('uses the target when the address is empty', () => {
    expect(checkHint('refused', '', 'relay.example.com:21117')).toContain(
      'Nothing accepts connections at relay.example.com:21117.',
    )
  })

  it.each(['other', null] as const)('has no hint for %s failures', (reason) => {
    expect(checkHint(reason, '192.0.2.1:21116', 'rd.example.com:21116')).toBeNull()
  })
})
