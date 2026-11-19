import type { components } from './schema'

type ErrorBody = components['schemas']['Error']

/**
 * The contract's error codes, plus two of the client's own: "unknown" for an
 * error body that is not the admin error shape, and "cross_origin" for a request
 * the client refused to send (status 0).
 */
export type ApiErrorCode = ErrorBody['error']['code'] | 'unknown' | 'cross_origin'

/** A non-2xx response from the admin API or the setup API, or a refused request. */
export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  /** Present for "internal"; matches X-Request-ID and the server log. */
  readonly requestId?: string

  constructor(status: number, code: ApiErrorCode, message: string, requestId?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    if (requestId !== undefined) this.requestId = requestId
  }

  /** Reads {"error":{"code","message","request_id"?}}; anything else becomes code "unknown". */
  static async fromResponse(response: Response): Promise<ApiError> {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => undefined)
    if (isErrorBody(body)) {
      const { code, message, request_id } = body.error
      return new ApiError(response.status, code, message, request_id)
    }
    // statusText is empty over HTTP/2.
    return new ApiError(
      response.status,
      'unknown',
      response.statusText || `HTTP ${response.status}`,
    )
  }
}

function isErrorBody(body: unknown): body is ErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false
  const e = body.error
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof e.code === 'string' &&
    'message' in e &&
    typeof e.message === 'string' &&
    (!('request_id' in e) || typeof e.request_id === 'string')
  )
}

/** What the UI shows for a failed call: a code to branch on and a plain sentence. */
export interface ErrorDescription {
  code: ApiErrorCode | 'network'
  message: string
  /** Present for "internal": quote it when reporting the problem. */
  requestId?: string
}

/**
 * Describes any error a query or mutation rejects with. An ApiError keeps its
 * code and the server's message. fetch rejects with a TypeError when the
 * server cannot be reached (offline, DNS, connection refused): "network".
 * Anything else is "unknown", and its internals stay out of the UI.
 */
export function describeError(err: unknown): ErrorDescription {
  if (err instanceof ApiError) {
    return err.requestId === undefined
      ? { code: err.code, message: err.message }
      : { code: err.code, message: err.message, requestId: err.requestId }
  }
  if (err instanceof TypeError) {
    return {
      code: 'network',
      message: 'Could not reach the server. Check the connection and try again.',
    }
  }
  return { code: 'unknown', message: 'Something went wrong. Try again.' }
}
