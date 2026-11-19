// The checks in the routes' beforeLoad: setup first, then the session, then
// the second factor. Each sends the user where they can go on, keeping the
// page they wanted as ?next=.
import type { QueryClient } from '@tanstack/react-query'
import { redirect } from '@tanstack/react-router'
import { ApiError } from '../api/errors'
import { nextFor, safeNext } from './next'
import { meQuery, setupStatusQuery, type Me } from './session'

interface Location {
  pathname: string
  href: string
}

const nextSearch = (next: string | undefined) => (next ? { next } : {})

/** Root: while setup is open every page is /first-run; once done, /first-run is not. */
export async function requireSetupState(queryClient: QueryClient, location: Location) {
  const { setup_complete } = await queryClient.ensureQueryData(setupStatusQuery)
  const onWizard = location.pathname === '/first-run'
  if (!setup_complete && !onWizard) throw redirect({ to: '/first-run', replace: true })
  // The guard of / then sends a signed-out user on to sign-in.
  if (setup_complete && onWizard) throw redirect({ to: '/', replace: true })
}

/**
 * The session, or a redirect to sign-in when there is none (a 401). `next` is
 * where sign-in should return to.
 */
async function requireSession(queryClient: QueryClient, next: string | undefined): Promise<Me> {
  try {
    return await queryClient.ensureQueryData(meQuery)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw redirect({ to: '/sign-in', search: nextSearch(next), replace: true })
    }
    throw err
  }
}

/** The app's pages: a session that has passed the second factor. */
export async function requireSignedIn(queryClient: QueryClient, location: Location): Promise<Me> {
  const next = nextFor(location.href)
  const me = await requireSession(queryClient, next)
  if (!me.mfa_passed) {
    if (me.totp_enrolled) {
      throw redirect({ to: '/sign-in/totp', search: nextSearch(next), replace: true })
    }
    if (me.user.totp_required) {
      throw redirect({ to: '/enroll-totp', search: nextSearch(next), replace: true })
    }
  }
  return me
}

/**
 * /sign-in: a user who is fully signed in goes on to `next` (or "/") instead.
 * Anyone else, including a session that has not passed TOTP, may sign in here;
 * when the session cannot be read the form is shown too.
 */
export async function leaveSignInWhenSignedIn(
  queryClient: QueryClient,
  next: string | undefined,
): Promise<void> {
  let me: Me
  try {
    me = await queryClient.ensureQueryData(meQuery)
  } catch {
    return
  }
  if (me.mfa_passed) throw redirect({ href: safeNext(next), replace: true })
}

/**
 * The second-factor pages: a session that has not passed it yet, on the right
 * one of them (the TOTP step, or enrollment). Anyone else goes on to `next`.
 */
export async function requireSecondFactor(
  queryClient: QueryClient,
  page: 'totp' | 'enroll',
  next: string | undefined,
): Promise<void> {
  const safe = nextFor(safeNext(next))
  const me = await requireSession(queryClient, safe)
  if (me.mfa_passed) throw redirect({ href: safeNext(next), replace: true })
  if (page === 'totp' && !me.totp_enrolled) {
    throw redirect({ to: '/enroll-totp', search: nextSearch(safe), replace: true })
  }
  if (page === 'enroll' && me.totp_enrolled) {
    throw redirect({ to: '/sign-in/totp', search: nextSearch(safe), replace: true })
  }
  if (page === 'enroll' && !me.user.totp_required) {
    throw redirect({ href: safeNext(next), replace: true })
  }
}

/** The search of the sign-in pages: ?next= when it is a string (checked by safeNext when used). */
export function validateNextSearch(search: Record<string, unknown>): { next?: string } {
  return typeof search.next === 'string' ? { next: search.next } : {}
}
