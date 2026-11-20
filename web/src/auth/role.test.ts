import { describe, expect, it } from 'vitest'
import { canVisit, mainNavPaths, redirectForRole } from './role'

const ALL = ['/', '/devices', '/sessions', '/audit', '/groups', '/tags', '/policies']

describe('mainNavPaths', () => {
  it('shows an owner and an admin every item', () => {
    expect(mainNavPaths('owner')).toEqual(ALL)
    expect(mainNavPaths('admin')).toEqual(ALL)
  })

  it('shows a user Command Center, Devices, Sessions and Audit Log only', () => {
    expect(mainNavPaths('user')).toEqual(['/', '/devices', '/sessions', '/audit'])
  })
})

describe('redirectForRole', () => {
  const blocked = [
    '/settings',
    '/settings/',
    '/settings/users',
    '/settings/server',
    '/groups',
    '/tags',
    '/devices/queue',
    '/policies',
  ]
  it.each(blocked)('sends a user from %s to /', (path) => {
    expect(redirectForRole('user', path)).toBe('/')
    expect(canVisit('user', path)).toBe(false)
  })

  it.each([
    '/',
    '/devices',
    '/devices/abc',
    '/sessions',
    '/audit',
    '/account',
    '/account/appearance',
  ])('lets a user visit %s', (path) => {
    expect(redirectForRole('user', path)).toBeUndefined()
    expect(canVisit('user', path)).toBe(true)
  })

  it('does not mistake a path that only starts with a blocked name', () => {
    expect(redirectForRole('user', '/settingsfoo')).toBeUndefined()
    expect(redirectForRole('user', '/groupsx')).toBeUndefined()
  })

  it.each(['owner', 'admin'] as const)('never redirects an %s', (role) => {
    for (const path of [...blocked, '/', '/devices']) {
      expect(redirectForRole(role, path)).toBeUndefined()
    }
  })
})
