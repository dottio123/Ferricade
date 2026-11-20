import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Me } from './session'
import { requireSecondFactor, requireSignedIn } from './guard'

const state = vi.hoisted(() => ({ me: null as Me | null }))

vi.mock('./session', () => ({
  meQuery: { queryKey: ['me'], queryFn: () => Promise.resolve(state.me) },
  setupStatusQuery: {},
}))

describe('requireSignedIn', () => {
  beforeEach(() => {
    state.me = {
      user: {
        id: 'u1',
        username: 'alex',
        role: 'owner',
        display_name: 'Alex',
        totp_required: false,
      },
      mfa_passed: false,
      totp_enrolled: false,
      csrf_token: 'csrf',
    } as Me
  })

  it('allows a session through when TOTP is optional and not enrolled', async () => {
    await expect(
      requireSignedIn(new QueryClient(), { pathname: '/', href: '/' }),
    ).resolves.toMatchObject({ mfa_passed: false, totp_enrolled: false })
  })

  it('redirects an enrolled account to the TOTP sign-in step', async () => {
    state.me = { ...state.me!, totp_enrolled: true }
    await expect(
      requireSignedIn(new QueryClient(), { pathname: '/', href: '/' }),
    ).rejects.toMatchObject({ options: { to: '/sign-in/totp' } })
  })

  it('redirects an account that must enroll to enrollment', async () => {
    state.me = { ...state.me!, user: { ...state.me!.user, totp_required: true } }
    await expect(
      requireSignedIn(new QueryClient(), { pathname: '/', href: '/' }),
    ).rejects.toMatchObject({ options: { to: '/enroll-totp' } })
  })

  it('sends an optional account away from the enrollment page', async () => {
    await expect(requireSecondFactor(new QueryClient(), 'enroll', undefined)).rejects.toMatchObject(
      {
        options: { href: '/' },
      },
    )
  })
})
