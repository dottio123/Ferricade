import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, setUnauthorizedHandler, unwrap } from '../api/client'
import { queryKeys } from '../lib/queryKeys'
import { leaveSignInWhenSignedIn } from './guard'
import { meQuery } from './session'
import {
  createCsrfRejectedHandler,
  createSecondFactorRequiredHandler,
  createUnauthorizedHandler,
  forgetSessionData,
  signInShown,
  whenSignInShows,
  type SessionNavigation,
} from './unauthorized'

function setup(location: { pathname: string; href: string; search?: Record<string, unknown> }) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.me(), { signed: 'in' })
  queryClient.setQueryData(queryKeys.devices.all(), ['a device'])
  queryClient.setQueryData(queryKeys.setupStatus(), { setup_complete: true })
  let settle: () => void = () => {}
  const nav = {
    location: () => ({ search: {}, ...location }),
    toSignIn: vi.fn<(next: string | undefined) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    ),
  } satisfies SessionNavigation
  const handler = createUnauthorizedHandler(nav, queryClient)
  return { queryClient, nav, handler, settle: () => settle() }
}

afterEach(() => {
  signInShown()
  setUnauthorizedHandler(() => {})
  vi.restoreAllMocks()
})

describe('the unauthorized handler', () => {
  it('sends the user to sign-in with the page they were on', () => {
    const { nav, handler } = setup({ pathname: '/devices', href: '/devices?state=pending' })
    handler()
    expect(nav.toSignIn).toHaveBeenCalledExactlyOnceWith('/devices?state=pending')
  })

  it('leaves next out on the command center', () => {
    const { nav, handler } = setup({ pathname: '/', href: '/' })
    handler()
    expect(nav.toSignIn).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('never puts an unsafe next in the URL', () => {
    const { nav, handler } = setup({ pathname: '//evil.example', href: '//evil.example' })
    handler()
    expect(nav.toSignIn).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('forgets the session at once, and every other cached response once sign-in shows', async () => {
    const { queryClient, handler, settle } = setup({ pathname: '/devices', href: '/devices' })
    handler()
    expect(queryClient.getQueryData(queryKeys.me())).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.devices.all())).toEqual(['a device'])
    // A finished navigation is not enough: while the sign-in route's code
    // loads, React keeps the old page on screen, and its queries, once
    // removed, would fetch again (and get 401s).
    settle()
    await Promise.resolve()
    await Promise.resolve()
    expect(queryClient.getQueryData(queryKeys.devices.all())).toEqual(['a device'])
    signInShown()
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.devices.all())).toBeUndefined(),
    )
    // Whether setup is done does not depend on who is signed in.
    expect(queryClient.getQueryData(queryKeys.setupStatus())).toEqual({ setup_complete: true })
  })

  it('keeps public setup and OIDC state while removing session and unrelated queries', () => {
    const queryClient = new QueryClient()
    const oidcPublicKey = queryKeys.oidcPublic()
    queryClient.setQueryData(queryKeys.setupStatus(), { setup_complete: true })
    queryClient.setQueryData(oidcPublicKey, { enabled: true, display_name: 'Authentik' })
    queryClient.setQueryData(['auth', 'me'], { signed: 'in' })
    queryClient.setQueryData(['unrelated'], { value: true })

    forgetSessionData(queryClient)

    expect(queryClient.getQueryData(queryKeys.setupStatus())).toEqual({ setup_complete: true })
    expect(queryClient.getQueryData(oidcPublicKey)).toEqual({
      enabled: true,
      display_name: 'Authentik',
    })
    expect(queryClient.getQueryData(['auth', 'me'])).toBeUndefined()
    expect(queryClient.getQueryData(['unrelated'])).toBeUndefined()
  })

  it('is idempotent: a burst of 401s navigates once', async () => {
    const { nav, handler, settle } = setup({ pathname: '/devices', href: '/devices' })
    handler()
    handler()
    handler()
    expect(nav.toSignIn).toHaveBeenCalledOnce()
    settle()
    await Promise.resolve()
  })

  it('does nothing more on the sign-in page itself', () => {
    const { nav, handler, queryClient } = setup({ pathname: '/sign-in', href: '/sign-in' })
    handler()
    expect(nav.toSignIn).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(queryKeys.me())).toBeUndefined()
  })

  it('keeps the old page cache until sign-in mounts when a 401 arrives during sign-out', async () => {
    const { nav, handler, queryClient } = setup({ pathname: '/sign-in', href: '/sign-in' })
    const cleanup = whenSignInShows().then(() => forgetSessionData(queryClient))

    handler()
    expect(nav.toSignIn).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(queryKeys.me())).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.devices.all())).toEqual(['a device'])

    signInShown()
    await cleanup
    expect(queryClient.getQueryData(queryKeys.devices.all())).toBeUndefined()
  })

  it('does not redirect the sign-in guard on cached authentication after a 401 during sign-out', async () => {
    const { handler, queryClient } = setup({ pathname: '/sign-in', href: '/sign-in' })
    queryClient.setQueryData(queryKeys.me(), { mfa_passed: true })
    const cleanup = whenSignInShows().then(() => forgetSessionData(queryClient))
    setUnauthorizedHandler(handler)
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json(
          { error: { code: 'unauthenticated', message: 'Session ended' } },
          { status: 401 },
        ),
      )

    await expect(unwrap(api.GET('/admin/api/v1/stats/summary'))).rejects.toMatchObject({
      status: 401,
    })
    await expect(leaveSignInWhenSignedIn(queryClient, undefined)).resolves.toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.me())).toBeUndefined()
    expect(fetch.mock.calls.map(([request]) => new URL((request as Request).url).pathname)).toEqual(
      ['/admin/api/v1/stats/summary', '/admin/api/v1/auth/me'],
    )

    signInShown()
    await cleanup
  })

  it('does not refetch me when the old shell rerenders during sign-out, and resumes on the next page', async () => {
    const { handler, queryClient } = setup({ pathname: '/sign-in', href: '/sign-in' })
    const queryFn = vi.fn(async () => {
      throw new Error('Session ended')
    })
    const options = { ...meQuery, queryFn, staleTime: Infinity }
    const observer = new QueryObserver(queryClient, options)
    const unsubscribe = observer.subscribe(() => {})
    const cleanup = whenSignInShows().then(() => forgetSessionData(queryClient))

    try {
      handler()
      expect(queryClient.getQueryData(queryKeys.me())).toBeUndefined()
      // React Query applies options again when the still-mounted shell rerenders.
      observer.setOptions(options)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(queryFn).not.toHaveBeenCalled()

      signInShown()
      await cleanup
      observer.setOptions(options)
      await vi.waitFor(() => expect(queryFn).toHaveBeenCalledOnce())
    } finally {
      unsubscribe()
      signInShown()
      await cleanup
      queryClient.clear()
    }
  })

  it('does nothing more in the setup wizard', () => {
    const { nav, handler } = setup({ pathname: '/first-run', href: '/first-run' })
    handler()
    expect(nav.toSignIn).not.toHaveBeenCalled()
  })

  it('goes back to the password step from the TOTP step, keeping a safe next', () => {
    const { nav, handler } = setup({
      pathname: '/sign-in/totp',
      href: '/sign-in/totp?next=%2Fdevices',
      search: { next: '/devices' },
    })
    handler()
    expect(nav.toSignIn).toHaveBeenCalledExactlyOnceWith('/devices')
  })

  it('drops an unsafe next on the way back from the enrollment page', () => {
    const { nav, handler } = setup({
      pathname: '/enroll-totp',
      href: '/enroll-totp?next=https%3A%2F%2Fevil.example',
      search: { next: 'https://evil.example' },
    })
    handler()
    expect(nav.toSignIn).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('never throws, even when navigation does', () => {
    const queryClient = new QueryClient()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler = createUnauthorizedHandler(
      {
        location: () => ({ pathname: '/devices', href: '/devices', search: {} }),
        toSignIn: () => {
          throw new Error('router is gone')
        },
      },
      queryClient,
    )
    expect(() => handler()).not.toThrow()
    expect(errors).toHaveBeenCalled()
  })

  it('tries again after a navigation that failed', async () => {
    const queryClient = new QueryClient()
    const toSignIn = vi
      .fn<(next: string | undefined) => Promise<void>>()
      .mockRejectedValueOnce(new Error('cancelled'))
      .mockResolvedValue(undefined)
    const handler = createUnauthorizedHandler(
      { location: () => ({ pathname: '/devices', href: '/devices', search: {} }), toSignIn },
      queryClient,
    )
    handler()
    await vi.waitFor(() => expect(toSignIn).toHaveBeenCalledOnce())
    await Promise.resolve()
    await Promise.resolve()
    handler()
    expect(toSignIn).toHaveBeenCalledTimes(2)
  })
})

describe('the csrf-rejected handler', () => {
  it('refetches the session (a fresh CSRF token) and leaves everything else alone', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.me(), { signed: 'in' })
    queryClient.setQueryData(queryKeys.devices.all(), ['a device'])
    createCsrfRejectedHandler(queryClient)()
    expect(queryClient.getQueryState(queryKeys.me())?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.devices.all())?.isInvalidated).toBe(false)
    expect(queryClient.getQueryData(queryKeys.devices.all())).toEqual(['a device'])
  })
})

describe('the second-factor-required handler', () => {
  function setup2() {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.me(), { signed: 'in' })
    queryClient.setQueryData(queryKeys.devices.all(), ['a device'])
    let settle: (ok: boolean) => void = () => {}
    const recheck = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = (ok) => (ok ? resolve() : reject(new Error('navigation failed')))
        }),
    )
    const handler = createSecondFactorRequiredHandler(recheck, queryClient)
    return { queryClient, recheck, handler, settle: (ok = true) => settle(ok) }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('forgets the session (so the guard asks again) and re-runs the guard, keeping the data', () => {
    const { queryClient, recheck, handler } = setup2()
    handler()
    expect(queryClient.getQueryData(queryKeys.me())).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.devices.all())).toEqual(['a device'])
    expect(recheck).toHaveBeenCalledOnce()
  })

  it('re-runs the guard once for a burst, and again after it settled', async () => {
    const { recheck, handler, settle } = setup2()
    handler()
    handler()
    handler()
    expect(recheck).toHaveBeenCalledOnce()
    settle()
    await flush()
    handler()
    expect(recheck).toHaveBeenCalledTimes(2)
  })

  it('never throws, and re-arms after a failed recheck', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { recheck, handler, settle } = setup2()
    expect(() => handler()).not.toThrow()
    settle(false)
    await flush()
    expect(consoleError).toHaveBeenCalledOnce()
    handler()
    expect(recheck).toHaveBeenCalledTimes(2)
  })
})
