import { describe, expect, it } from 'vitest'
import { ApiError, describeError } from './errors'

describe('describeError', () => {
  it("gives an ApiError's code and the server's message", () => {
    expect(describeError(new ApiError(409, 'name_taken', 'A tag with that name exists'))).toEqual({
      code: 'name_taken',
      message: 'A tag with that name exists',
    })
  })

  it('keeps the request id of an internal error', () => {
    expect(describeError(new ApiError(500, 'internal', 'internal error', 'req-42'))).toEqual({
      code: 'internal',
      message: 'internal error',
      requestId: 'req-42',
    })
  })

  it('calls a TypeError from fetch a network error, in plain words', () => {
    const d = describeError(new TypeError('Failed to fetch'))
    expect(d.code).toBe('network')
    expect(d.message).toBe('Could not reach the server. Check the connection and try again.')
    expect(d).not.toHaveProperty('requestId')
  })

  it.each([
    ['an Error', new Error('boom')],
    ['a string', 'boom'],
    ['undefined', undefined],
    ['an abort', new DOMException('aborted', 'AbortError')],
  ])('calls anything else (%s) unknown, without its internals', (_, err) => {
    expect(describeError(err)).toEqual({
      code: 'unknown',
      message: 'Something went wrong. Try again.',
    })
  })
})
