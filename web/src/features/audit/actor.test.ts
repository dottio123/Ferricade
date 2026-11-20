import { describe, expect, it } from 'vitest'
import { formatActorName } from './actor'

describe('formatActorName', () => {
  it('identifies unauthenticated auth events by client address', () => {
    expect(
      formatActorName({ actorUserId: null, action: 'auth.login_failed', actorIp: '192.0.2.42' }),
    ).toBe('Unknown client at 192.0.2.42')
  })
  it('returns "A device or the setup wizard" when actorUserId is null', () => {
    expect(
      formatActorName({
        actorUserId: null,
        currentUserId: 'user-1',
        currentUserRole: 'owner',
      }),
    ).toBe('A device or the setup wizard')
  })

  it('returns "You" when actorUserId matches currentUserId', () => {
    expect(
      formatActorName({
        actorUserId: 'user-1',
        currentUserId: 'user-1',
        currentUserRole: 'admin',
      }),
    ).toBe('You')

    expect(
      formatActorName({
        actorUserId: 'user-1',
        currentUserId: 'user-1',
        currentUserRole: 'owner',
      }),
    ).toBe('You')
  })

  it('resolves actor name from usersMap when currentUserRole is owner', () => {
    const usersMap = new Map([
      ['user-2', 'Alex'],
      ['user-3', 'samuel (Sam)'],
    ])

    expect(
      formatActorName({
        actorUserId: 'user-2',
        currentUserId: 'user-1',
        currentUserRole: 'owner',
        usersMap,
      }),
    ).toBe('Alex')

    expect(
      formatActorName({
        actorUserId: 'user-3',
        currentUserId: 'user-1',
        currentUserRole: 'owner',
        usersMap,
      }),
    ).toBe('samuel (Sam)')

    // If not in map, falls back to "An admin"
    expect(
      formatActorName({
        actorUserId: 'user-unknown',
        currentUserId: 'user-1',
        currentUserRole: 'owner',
        usersMap,
      }),
    ).toBe('An admin')
  })

  it('returns "An admin" for other users when currentUserRole is admin (never looks up usersMap)', () => {
    const usersMap = new Map([['user-2', 'Alex']])

    expect(
      formatActorName({
        actorUserId: 'user-2',
        currentUserId: 'user-1',
        currentUserRole: 'admin',
        usersMap,
      }),
    ).toBe('An admin')
  })
})
