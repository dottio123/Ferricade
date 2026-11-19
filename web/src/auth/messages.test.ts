import { renderHook, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/errors'
import { getAuthErrorMessage, useBusyRetry } from './messages'

describe('getAuthErrorMessage', () => {
  it('maps locked error', () => {
    const err = new ApiError(423, 'locked', 'account locked')
    expect(getAuthErrorMessage(err)).toBe('Too many attempts. Try again in a few minutes.')
  })

  it('maps invalid_code error', () => {
    const err = new ApiError(400, 'invalid_code', 'wrong code')
    expect(getAuthErrorMessage(err)).toBe("That code didn't match. Check your app and try again.")
  })

  it('maps code_already_used error', () => {
    const err = new ApiError(400, 'code_already_used', 'code already used')
    expect(getAuthErrorMessage(err)).toBe('That code was just used. Wait for the next one.')
  })

  it('maps busy error', () => {
    const err = new ApiError(503, 'busy', 'database locked')
    expect(getAuthErrorMessage(err)).toBe('The server is busy. Trying again…')
  })

  it('maps busy error after retry to calm try again in a moment message', () => {
    const err = new ApiError(503, 'busy', 'database locked')
    expect(getAuthErrorMessage(err, undefined, { retried: true })).toBe(
      'The server is busy. Try again in a moment.',
    )
    expect(getAuthErrorMessage(err, 'login', true)).toBe(
      'The server is busy. Try again in a moment.',
    )
  })

  it('maps rate_limited error', () => {
    const err = new ApiError(429, 'rate_limited', 'slow down')
    expect(getAuthErrorMessage(err)).toBe(
      'Too many attempts from this network. Wait a minute and try again.',
    )
  })

  it('asks SSO-only users to sign in again before re-enrolling TOTP', () => {
    const err = new ApiError(403, 'reauthentication_required', 'sign in again')
    expect(getAuthErrorMessage(err, 'enroll')).toBe(
      'Sign in again before re-enrolling your authenticator.',
    )
  })

  it('maps login 401 unauthenticated error', () => {
    const err = new ApiError(401, 'unauthenticated', 'wrong username or password')
    expect(getAuthErrorMessage(err, 'login')).toBe("That username and password don't match.")
  })

  it('maps enroll verify 409 incomplete/expired error', () => {
    const err = new ApiError(409, 'incomplete', 'start enrollment first')
    expect(getAuthErrorMessage(err, 'enroll')).toBe('That setup code expired.')
  })

  it('falls back to describeError message for unmapped codes', () => {
    const err = new ApiError(400, 'bad_request', 'custom validation failed')
    expect(getAuthErrorMessage(err)).toBe('custom validation failed')
  })

  it('falls back to network error message for network failure', () => {
    const err = new TypeError('Failed to fetch')
    expect(getAuthErrorMessage(err)).toBe(
      'Could not reach the server. Check the connection and try again.',
    )
  })
})

describe('useBusyRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('submits immediately when called', () => {
    const submitFn = vi.fn()
    const { result } = renderHook(() => useBusyRetry(submitFn, null))

    act(() => {
      result.current.submit({ code: '123456' })
    })

    expect(submitFn).toHaveBeenCalledTimes(1)
    expect(submitFn).toHaveBeenCalledWith({ code: '123456' })
  })

  it('retries once after 1s on busy error', () => {
    const submitFn = vi.fn()
    let error: unknown = null

    const { result, rerender } = renderHook(() => useBusyRetry(submitFn, error))

    // Initial submission
    act(() => {
      result.current.submit({ code: '123456' })
    })
    expect(submitFn).toHaveBeenCalledTimes(1)

    // Simulate busy error response
    error = new ApiError(503, 'busy', 'busy')
    rerender()

    // Fast-forward 500ms - should not have retried yet
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(submitFn).toHaveBeenCalledTimes(1)

    // Fast-forward another 500ms (1000ms total) - should retry now
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(submitFn).toHaveBeenCalledTimes(2)
    expect(submitFn).toHaveBeenNthCalledWith(2, { code: '123456' })

    // Simulate second busy error response - should not retry again
    rerender()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(submitFn).toHaveBeenCalledTimes(2)
  })

  it('cancels pending retry on unmount', () => {
    const submitFn = vi.fn()
    const error = new ApiError(503, 'busy', 'busy')

    const { result, unmount, rerender } = renderHook(() => useBusyRetry(submitFn, error))

    act(() => {
      result.current.submit({ code: '123456' })
    })
    rerender()
    expect(submitFn).toHaveBeenCalledTimes(1)

    // Unmount before 1s timer triggers
    unmount()

    act(() => {
      vi.advanceTimersByTime(1500)
    })

    // Should not have called submitFn again after unmount
    expect(submitFn).toHaveBeenCalledTimes(1)
  })

  it('clears credentials on retry and sets retried state', () => {
    const submitFn = vi.fn()
    let error: unknown = null

    const { result, rerender } = renderHook(() => useBusyRetry(submitFn, error, false))

    act(() => {
      result.current.submit({ username: 'alex', password: 'secretpassword' })
    })

    expect(submitFn).toHaveBeenCalledTimes(1)
    expect(result.current.retried).toBe(false)

    // Trigger busy error
    error = new ApiError(503, 'busy', 'busy')
    rerender()

    // Fast forward through retry
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(submitFn).toHaveBeenCalledTimes(2)
    expect(submitFn).toHaveBeenNthCalledWith(2, {
      username: 'alex',
      password: 'secretpassword',
    })
    expect(result.current.retried).toBe(true)

    // Subsequent error after retry should not trigger any further retries
    error = new ApiError(503, 'busy', 'still busy')
    rerender()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(submitFn).toHaveBeenCalledTimes(2)
  })

  it('clears remembered credentials on non-busy error without retry', () => {
    const submitFn = vi.fn()
    let error: unknown = null

    const { result, rerender } = renderHook(() => useBusyRetry(submitFn, error, false))

    act(() => {
      result.current.submit({ username: 'alex', password: 'secretpassword' })
    })
    expect(submitFn).toHaveBeenCalledTimes(1)

    // Trigger non-busy error (e.g. 401 unauthenticated)
    error = new ApiError(401, 'unauthenticated', 'invalid credentials')
    rerender()

    // Feed a busy error afterwards without a new submit
    error = new ApiError(503, 'busy', 'database locked')
    rerender()

    // Advancing time should not fire any retry because credentials were wiped on 401
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(submitFn).toHaveBeenCalledTimes(1)
    expect(result.current.retried).toBe(false)
  })

  it('clears credentials on unmount', () => {
    const submitFn = vi.fn()
    let error: unknown = null
    const { result, unmount, rerender } = renderHook(() => useBusyRetry(submitFn, error, false))

    act(() => {
      result.current.submit({ username: 'alex', password: 'secretpassword' })
    })
    expect(submitFn).toHaveBeenCalledTimes(1)

    // Schedule retry on busy error
    error = new ApiError(503, 'busy', 'busy')
    rerender()

    // Unmount cancels pending timer and clears credentials
    unmount()

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(submitFn).toHaveBeenCalledTimes(1)
  })

  it('clears credentials on successful completion', () => {
    const submitFn = vi.fn()
    let error: unknown = null
    let isSuccess = false

    const { result, rerender } = renderHook(() => useBusyRetry(submitFn, error, isSuccess))

    act(() => {
      result.current.submit({ username: 'alex', password: 'secretpassword' })
    })
    expect(submitFn).toHaveBeenCalledTimes(1)

    // Operation succeeds
    isSuccess = true
    rerender()

    // Now feed a busy error afterwards without a new submit
    isSuccess = false
    error = new ApiError(503, 'busy', 'busy')
    rerender()

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(submitFn).toHaveBeenCalledTimes(1)
  })
})
