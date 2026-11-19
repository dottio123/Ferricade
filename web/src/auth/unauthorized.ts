// What the app does when the session is gone (a 401), its CSRF token is
// rejected (a 403 "csrf"), or it needs the second factor again (a 403
// "mfa_required" or "totp_enroll_required"): the API client calls these
// handlers (src/api/client.ts set…Handler).
import type { QueryClient } from '@tanstack/react-query'
import {
  setCsrfRejectedHandler,
  setSecondFactorRequiredHandler,
  setUnauthorizedHandler,
} from '../api/client'
import { queryKeys } from '../lib/queryKeys'
import type { AppRouter } from '../router'
import { nextFor, safeNext } from './next'

/** The router, as far as the handler needs it. */
export interface SessionNavigation {
  /** The location being shown or loaded. */
  location(): { pathname: string; href: string; search: unknown }
  /** Goes to /sign-in, with ?next= when given. */
  toSignIn(next: string | undefined): Promise<void>
}

const PUBLIC_QUERY_KEYS = [queryKeys.setupStatus(), queryKeys.oidcPublic()] as const

/**
 * Removes session data: it was read with a session that ended (or is being
 * replaced), and another user may sign in next. Setup status and public OIDC
 * state are the same for everyone.
 */
export function forgetSessionData(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: (q) =>
      !PUBLIC_QUERY_KEYS.some(
        (key) => key.length === q.queryKey.length && key.every((part, i) => q.queryKey[i] === part),
      ),
  })
}

let signInWaiters: (() => void)[] = []

/** The old page must not refetch its session while sign-in replaces it. */
export function isSignInPending(): boolean {
  return signInWaiters.length > 0
}

/**
 * Resolves once the sign-in page is on screen, when the page before it is
 * gone. A finished navigation is too early: while the sign-in route's code
 * loads, React keeps the old page mounted, and a query of it that is removed
 * and then re-renders fetches again. Ask before navigating.
 */
export function whenSignInShows(): Promise<void> {
  return new Promise((resolve) => signInWaiters.push(resolve))
}

/** Called by the sign-in page when it mounts. */
export function signInShown(): void {
  const waiters = signInWaiters
  signInWaiters = []
  for (const resolve of waiters) resolve()
}

/**
 * Forgets the session's data, then sends the user to /sign-in?next=<the page>.
 * Idempotent: a burst of 401s navigates once. It never throws.
 */
export function createUnauthorizedHandler(
  nav: SessionNavigation,
  queryClient: QueryClient,
): () => void {
  let navigating = false

  return () => {
    try {
      // At once, so the guard asks the server again on the next navigation.
      queryClient.removeQueries({ queryKey: queryKeys.me() })
      if (navigating) return

      const { pathname, href, search } = nav.location()
      if (pathname === '/sign-in') {
        // Sign-out (or another 401) may already be navigating here. The old
        // page is still mounted until signInShown, so its pending cleanup must
        // keep the cache alive until then.
        if (signInWaiters.length === 0) forgetSessionData(queryClient)
        return
      }
      if (pathname === '/first-run') {
        forgetSessionData(queryClient)
        return
      }
      // From a later sign-in step back to the first, keeping where it was going.
      const next =
        pathname === '/sign-in/totp' || pathname === '/enroll-totp'
          ? nextFor(safeNext(nextParam(search)))
          : nextFor(href)

      navigating = true
      // The rest is forgotten once sign-in shows: done now, the page still on
      // screen would fetch it all again (and get more 401s).
      void whenSignInShows().then(() => forgetSessionData(queryClient))
      const done = () => {
        navigating = false
      }
      nav.toSignIn(next).then(done, done)
    } catch (err) {
      navigating = false
      console.error('ferricade: could not go to sign-in after a 401', err)
    }
  }
}

function nextParam(search: unknown): unknown {
  return typeof search === 'object' && search !== null && 'next' in search ? search.next : undefined
}

/**
 * After a 403 "csrf", refetches GET /auth/me, whose answer carries the
 * session's current token (the client stores it). The failed request is not
 * retried: the user sees its error and tries again.
 */
export function createCsrfRejectedHandler(queryClient: QueryClient): () => void {
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.me() })
  }
}

/**
 * After a 403 asking for the second factor, forgets the cached session and
 * re-runs the current route's guard (`recheck`), which reads GET /auth/me
 * again and sends the user to /sign-in/totp or /enroll-totp with ?next=.
 * Cached page data is kept: it is the same user. A burst of 403s rechecks
 * once. It never throws.
 */
export function createSecondFactorRequiredHandler(
  recheck: () => Promise<void>,
  queryClient: QueryClient,
): () => void {
  let pending = false
  return () => {
    queryClient.removeQueries({ queryKey: queryKeys.me() })
    if (pending) return
    pending = true
    let result: Promise<void>
    try {
      result = recheck()
    } catch (err) {
      result = Promise.reject(err)
    }
    result
      .catch((err: unknown) => {
        console.error('ferricade: could not go to the second-factor step after a 403', err)
      })
      .finally(() => {
        pending = false
      })
  }
}

/** Registers the session handlers with the API client (once, at startup). */
export function installSessionHandlers(router: AppRouter, queryClient: QueryClient): void {
  setCsrfRejectedHandler(createCsrfRejectedHandler(queryClient))
  setSecondFactorRequiredHandler(
    createSecondFactorRequiredHandler(() => router.invalidate(), queryClient),
  )
  setUnauthorizedHandler(
    createUnauthorizedHandler(
      {
        // latestLocation is the page being loaded, not only the one on screen.
        location: () => router.latestLocation,
        toSignIn: (next) =>
          router.navigate({ to: '/sign-in', search: next ? { next } : {}, replace: true }),
      },
      queryClient,
    ),
  )
}
