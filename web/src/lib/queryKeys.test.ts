import { describe, expect, it } from 'vitest'
import { queryKeys } from './queryKeys'

describe('queryKeys', () => {
  it('builds every key with a function, the root first', () => {
    expect(queryKeys.devices.all()).toEqual(['devices'])
    expect(queryKeys.devices.list({ state: 'pending' })).toEqual(['devices', { state: 'pending' }])
    expect(queryKeys.sessions.all()).toEqual(['sessions'])
    expect(queryKeys.audit.all()).toEqual(['audit'])
    expect(queryKeys.history('7d')).toEqual(['history', '7d'])
  })

  it('has a root key for every device detail and every session-stats query', () => {
    expect(queryKeys.device()).toEqual(['device'])
    expect(queryKeys.device('6f1c')).toEqual(['device', '6f1c'])
    expect(queryKeys.sessionStats()).toEqual(['session-stats'])
    expect(queryKeys.sessionStats({ range: '30d' })).toEqual(['session-stats', { range: '30d' }])
    // tz changes the answer (day buckets), so it is part of the key
    expect(queryKeys.sessionStats({ range: '7d', tz: 'America/New_York' })).not.toEqual(
      queryKeys.sessionStats({ range: '7d', tz: 'UTC' }),
    )
  })

  it('builds devicePolicy and policyPush keys', () => {
    expect(queryKeys.devicePolicy('dev-123')).toEqual(['device', 'dev-123', 'policy'])
    expect(queryKeys.policyPush()).toEqual(['settings', 'policy-push'])
  })

  it('takes only the ranges the contract has (checked by typecheck)', () => {
    // @ts-expect-error -- GET /stats/history has no 1h range
    void queryKeys.history('1h')
    // @ts-expect-error -- GET /sessions/stats has no 24h range
    void queryKeys.sessionStats({ range: '24h' })
  })
})

describe('infinite list keys', () => {
  it('differ from the plain list key for the same filters, under the same root', () => {
    const cases = [
      [
        queryKeys.devices.list({ state: 'pending' }),
        queryKeys.devices.infinite({ state: 'pending' }),
      ],
      [
        queryKeys.sessions.list({ device_id: 'd1' }),
        queryKeys.sessions.infinite({ device_id: 'd1' }),
      ],
      [
        queryKeys.audit.list({ action: 'device.approve' }),
        queryKeys.audit.infinite({ action: 'device.approve' }),
      ],
    ] as const
    for (const [plain, infinite] of cases) {
      expect(infinite).not.toEqual(plain)
      expect(infinite[0]).toBe(plain[0])
    }
    expect(queryKeys.devices.infinite({ state: 'pending' })).toEqual([
      'devices',
      'infinite',
      { state: 'pending' },
    ])
    expect(queryKeys.sessions.infinite()).toEqual(['sessions', 'infinite', {}])
    expect(queryKeys.audit.infinite()).toEqual(['audit', 'infinite', {}])
  })

  it('take the contract filters but no cursor or invented parameter (checked by typecheck)', () => {
    void queryKeys.devices.infinite({ sort: 'name', order: 'desc' })
    // @ts-expect-error -- the sort key must be one of the contract values
    void queryKeys.devices.infinite({ sort: 'hostname' })
    // @ts-expect-error -- GET /devices has no page parameter
    void queryKeys.devices.infinite({ page: 2 })
    // @ts-expect-error -- the cursor is the page param, never part of the key
    void queryKeys.devices.infinite({ cursor: 'abc' })
    // @ts-expect-error -- the cursor is the page param, never part of the key
    void queryKeys.sessions.infinite({ cursor: 'abc' })
    // @ts-expect-error -- the cursor is the page param, never part of the key
    void queryKeys.audit.infinite({ cursor: 'abc' })
  })
})

describe('tags and users', () => {
  it('have a root key for invalidation and a list key that takes the contract params', () => {
    expect(queryKeys.tags.all()).toEqual(['tags'])
    expect(queryKeys.tags.list()).toEqual(['tags', {}])
    expect(queryKeys.tags.list({ limit: 200 })).toEqual(['tags', { limit: 200 }])
    expect(queryKeys.users.all()).toEqual(['users'])
    expect(queryKeys.users.list({ limit: 10 })).toEqual(['users', { limit: 10 }])
    // @ts-expect-error -- GET /tags has no q parameter
    void queryKeys.tags.list({ q: 'office' })
    // @ts-expect-error -- GET /users has no role parameter
    void queryKeys.users.list({ role: 'owner' })
  })

  it('keeps groups whole: GET /groups takes no parameters', () => {
    expect(queryKeys.groups()).toEqual(['groups'])
  })
})
