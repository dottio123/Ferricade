import { describe, expect, it } from 'vitest'
import { oidcErrorMessage } from './oidc-messages'

describe('OIDC sign-in errors', () => {
  const cases = [
    ['not_allowed', 'Your account at Authentik is not in a group that may use Ferricade.'],
    [
      'no_account',
      'There is no Ferricade account for you, and new accounts are not created automatically. Ask an owner.',
    ],
    ['disabled', 'Your Ferricade account is disabled. Ask an owner.'],
    [
      'account_conflict',
      'Your email matches a Ferricade account that cannot be linked automatically. Ask an owner.',
    ],
    [
      'provider_error',
      'Signing in with Authentik did not work. Try again, or sign in with your password.',
    ],
    ['expired', 'Your sign-in took too long or was started again. Try again.'],
    ['rate_limited', 'Too many sign-in attempts. Wait a minute and try again.'],
    [
      'unknown',
      'Signing in with Authentik did not work. Try again, or sign in with your password.',
    ],
  ] as const
  it.each(cases)('maps %s', (code, expected) => {
    expect(oidcErrorMessage(code, 'Authentik')).toBe(expected)
  })
  it('uses a fallback provider name', () => {
    expect(oidcErrorMessage('not_allowed')).toContain('your provider')
  })
})
