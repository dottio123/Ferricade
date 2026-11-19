// The one way the app reaches the backend. Every call is typed by schema.d.ts
// (generated from internal/adminapi/openapi.yaml), so a path, method or field
// that is not in the contract fails `npm run typecheck`.
import createClient, {
  type FetchResponse,
  type Middleware,
  type ParamsOption,
  type RequestBodyOption,
} from 'openapi-fetch'
import { csrf } from './csrf'
import { ApiError } from './errors'
import type { paths } from './schema'

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const LOGIN = '/admin/api/v1/auth/login'

const baseOptions = {
  baseUrl: '',
  credentials: 'same-origin',
  // openapi-fetch keeps the fetch it is created with; looking it up per call
  // lets a fetch that is patched later (MSW in tests and the mock dev server) see the request.
  fetch: (request: Request) => globalThis.fetch(request),
} as const

let onUnauthorized: () => void = () => {}
let onCsrfRejected: () => void = () => {}
let onSecondFactorRequired: () => void = () => {}

/**
 * Registers what happens when the session is gone (a 401). It is called once
 * per burst: a 401 is ignored when its request was sent before the handler last
 * ran or before a new session token arrived, since those requests belong to a
 * burst already handled or to a session already replaced.
 */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

/**
 * Registers what happens when the server rejects the CSRF token (403 "csrf"):
 * the app fetches a fresh one (GET /auth/me). The request is not retried; the
 * caller gets the ApiError and the user can try again.
 */
export function setCsrfRejectedHandler(fn: () => void): void {
  onCsrfRejected = fn
}

/**
 * Registers what happens when the session needs its second factor again
 * mid-session (403 "mfa_required" or "totp_enroll_required", e.g. after an
 * owner reset this user's TOTP): the app re-runs its guard, which sends the
 * user to the TOTP or enrollment step. The request is not retried.
 */
export function setSecondFactorRequiredHandler(fn: () => void): void {
  onSecondFactorRequired = fn
}

// The "generation" advances when the unauthorized handler runs and when a new
// CSRF token (a new or rotated session) arrives.
let generation = 0
const sentInGeneration = new WeakMap<Request, number>()

// The paths whose 2xx responses carry the session's CSRF token, from the
// contract: the Record type makes typecheck fail when the contract gains or
// loses one. No other response is read for a token.
type JsonBody<R> = R extends { content: { 'application/json': infer B } } ? B : never
type OkBodies<Op> = Op extends { responses: infer Rs }
  ? { [S in keyof Rs]: S extends 200 | 201 ? JsonBody<Rs[S]> : never }[keyof Rs]
  : never
type CarriesToken<Item> = {
  [M in keyof Item]: OkBodies<Item[M]> extends infer B
    ? B extends { csrf_token: string }
      ? true
      : never
    : never
}[keyof Item]
type TokenPath = {
  [P in keyof paths]: true extends CarriesToken<paths[P]> ? P : never
}[keyof paths]
const TOKEN_PATHS: Record<TokenPath, true> = {
  '/admin/api/v1/auth/login': true,
  '/admin/api/v1/auth/me': true,
  '/admin/api/v1/auth/totp': true,
  '/admin/api/v1/auth/password': true,
  '/admin/api/v1/auth/totp/enroll/verify': true,
}
export const CSRF_TOKEN_PATHS: ReadonlySet<string> = new Set(Object.keys(TOKEN_PATHS))

async function captureCsrfToken(response: Response, schemaPath: string): Promise<void> {
  if (!CSRF_TOKEN_PATHS.has(schemaPath)) return
  if (!response.headers.get('Content-Type')?.includes('application/json')) return
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined)
  if (
    typeof body === 'object' &&
    body !== null &&
    'csrf_token' in body &&
    typeof body.csrf_token === 'string' &&
    body.csrf_token !== csrf.get()
  ) {
    csrf.set(body.csrf_token)
    generation++
  }
}

const sessionMiddleware: Middleware = {
  onRequest({ request }) {
    sentInGeneration.set(request, generation)
    const token = csrf.get()
    // The browser sets Origin itself; the server checks both.
    if (token && UNSAFE_METHODS.has(request.method)) request.headers.set('X-CSRF-Token', token)
  },
  async onResponse({ request, response, schemaPath }) {
    if (response.ok) {
      await captureCsrfToken(response, schemaPath)
      return
    }
    // A 401 from sign-in means wrong credentials, not a lost session.
    if (
      response.status === 401 &&
      schemaPath !== LOGIN &&
      sentInGeneration.get(request) === generation
    ) {
      generation++
      csrf.clear()
      // A broken handler must not replace the ApiError the caller is waiting for.
      try {
        onUnauthorized()
      } catch (err) {
        console.error('unauthorized handler failed', err)
      }
    }
    const error = await ApiError.fromResponse(response)
    if (error.status === 403 && error.code === 'csrf') {
      try {
        onCsrfRejected()
      } catch (err) {
        console.error('csrf-rejected handler failed', err)
      }
    }
    if (
      error.status === 403 &&
      (error.code === 'mfa_required' || error.code === 'totp_enroll_required')
    ) {
      try {
        onSecondFactorRequired()
      } catch (err) {
        console.error('second-factor handler failed', err)
      }
    }
    throw error
  },
}

// Defence in depth behind the call types (which allow no per-call baseUrl):
// a request for another origin is refused before it is sent, so the CSRF token
// and the setup token never leave this origin.
const sameOriginOnly: Middleware = {
  onRequest({ request }) {
    if (new URL(request.url).origin !== globalThis.location.origin) {
      throw new ApiError(0, 'cross_origin', 'Refused a request to another origin')
    }
  },
}

const errorMiddleware: Middleware = {
  async onResponse({ response }) {
    if (!response.ok) throw await ApiError.fromResponse(response)
  },
}

// openapi-fetch's own method types infer the init object as a type parameter
// and add an index signature to it, so an invented body field or option still
// compiles, and they accept per-call transport options (baseUrl, credentials,
// headers, fetch, middleware, parseAs). Here a call takes only the contract's
// parts (params, body) and an abort signal, typed from the path alone, so
// TypeScript rejects anything else. The clients also expose no use()/eject(),
// so no caller can remove the middleware.
type Method = 'get' | 'put' | 'post' | 'patch' | 'delete'
type PathsWith<Paths, M extends Method> = {
  [P in keyof Paths]: Paths[P] extends { [K in M]: object } ? P : never
}[keyof Paths]
type CallInit<Op> = ParamsOption<Op> & RequestBodyOption<Op> & { signal?: AbortSignal }
type InitFor<Item, M> = M extends keyof Item ? CallInit<Item[M]> : never
type InitArgs<I> = object extends I ? [init?: I] : [init: I]
type ResponseFor<Item, M> = M extends keyof Item
  ? Item[M] extends Record<string | number, unknown>
    ? FetchResponse<Item[M], InitFor<Item, M>, `${string}/${string}`>
    : never
  : never
type StrictMethod<Paths, M extends Method> = <P extends PathsWith<Paths, M>>(
  url: P,
  ...init: InitArgs<P extends keyof Paths ? InitFor<Paths[P], M> : never>
) => Promise<ResponseFor<Paths[P], M>>

export interface ApiClient<Paths> {
  GET: StrictMethod<Paths, 'get'>
  PUT: StrictMethod<Paths, 'put'>
  POST: StrictMethod<Paths, 'post'>
  PATCH: StrictMethod<Paths, 'patch'>
  DELETE: StrictMethod<Paths, 'delete'>
}

function strict<Paths extends object>(middleware: Middleware, headers?: Record<string, string>) {
  const client = createClient<Paths>({ ...baseOptions, headers })
  // sameOriginOnly runs first, before any token is attached.
  client.use(sameOriginOnly, middleware)
  const { GET, PUT, POST, PATCH, DELETE } = client
  // Same functions, narrower parameter types: every call ApiClient accepts,
  // openapi-fetch accepts too.
  return { GET, PUT, POST, PATCH, DELETE } as unknown as ApiClient<Paths>
}

type SetupPaths = { [P in keyof paths as P extends `/setup/${string}` ? P : never]: paths[P] }

// The session client reaches every path but the setup wizard's steps, which
// need the setup token (setupClient). GET /setup/status needs neither, and the
// app reads it with a session or without one.
type SessionPaths = {
  [
    P in keyof paths as P extends `/setup/${string}` ? (P extends '/setup/status' ? P : never) : P
  ]: paths[P]
}

/** The admin API client. Non-2xx responses reject with ApiError. */
export const api = strict<SessionPaths>(sessionMiddleware)

/**
 * A client for the first-run wizard (/first-run). It sends the setup token on
 * every request and knows nothing of sessions: no CSRF token, no unauthorized
 * handler. Non-2xx responses reject with ApiError.
 */
export function setupClient(token: string): ApiClient<SetupPaths> {
  return strict<SetupPaths>(errorMiddleware, { 'X-Setup-Token': token })
}

/**
 * Resolves to a call's data (undefined for 204), for TanStack Query's queryFn
 * and mutationFn. Both clients' middleware already rejects every non-2xx
 * response with ApiError, so a call that resolves was a 2xx.
 */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  const { data } = await p
  return data as T
}
