import * as React from 'react'
import { ApiError, describeError } from '../api/errors'

export type AuthContext = 'login' | 'totp' | 'enroll'

/**
 * Maps API errors to calm, user-friendly sentences for authentication flows.
 */
export function getAuthErrorMessage(
  err: unknown,
  context?: AuthContext,
  retriedOrOptions?: boolean | { retried?: boolean },
): string {
  const isRetried =
    typeof retriedOrOptions === 'boolean' ? retriedOrOptions : Boolean(retriedOrOptions?.retried)

  const desc = describeError(err)

  if (err instanceof ApiError) {
    if (context === 'login' && err.code === 'csrf') return err.message
    if (context === 'login' && (err.status === 401 || err.code === 'unauthenticated')) {
      return "That username and password don't match."
    }
    if (context === 'enroll' && (err.status === 409 || err.code === 'incomplete')) {
      return 'That setup code expired.'
    }
  }

  switch (desc.code) {
    case 'reauthentication_required':
      return 'Sign in again before re-enrolling your authenticator.'
    case 'locked':
      return 'Too many attempts. Try again in a few minutes.'
    case 'invalid_code':
      return "That code didn't match. Check your app and try again."
    case 'code_already_used':
      return 'That code was just used. Wait for the next one.'
    case 'busy':
      return isRetried
        ? 'The server is busy. Try again in a moment.'
        : 'The server is busy. Trying again…'
    case 'rate_limited':
      return 'Too many attempts from this network. Wait a minute and try again.'
    default:
      return desc.message
  }
}

export interface BusyRetryResult<T> {
  submit: (arg: T) => void
  retried: boolean
}

/**
 * Manages form submissions with a single 1s automatic retry on "busy" errors.
 * Credentials are kept only while waiting for retry, and cleared on retry, unmount,
 * successful completion, or any failed attempt that does not trigger a retry.
 */
export function useBusyRetry<T>(
  submitFn: (arg: T) => void,
  error: unknown,
  isSuccess?: boolean,
): BusyRetryResult<T> {
  const lastArgRef = React.useRef<T | null>(null)
  const retriedRef = React.useRef(false)
  const timerRef = React.useRef<number | null>(null)
  const [retried, setRetried] = React.useState(false)

  // Clear credentials on unmount
  React.useEffect(() => {
    return () => {
      lastArgRef.current = null
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  // Clear credentials on successful completion
  React.useEffect(() => {
    if (isSuccess) {
      lastArgRef.current = null
    }
  }, [isSuccess])

  const submit = React.useCallback(
    (arg: T) => {
      lastArgRef.current = arg
      retriedRef.current = false
      setRetried(false)
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      submitFn(arg)
    },
    [submitFn],
  )

  React.useEffect(() => {
    if (!error) return
    const desc = describeError(error)
    if (desc.code === 'busy' && !retriedRef.current && lastArgRef.current !== null) {
      retriedRef.current = true
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        const arg = lastArgRef.current
        // Cleared on retry
        lastArgRef.current = null
        if (arg !== null) {
          submitFn(arg)
          setRetried(true)
        }
      }, 1000)
    } else {
      // Clear remembered credentials after any failed attempt not scheduled for retry
      lastArgRef.current = null
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [error, submitFn])

  return { submit, retried }
}
