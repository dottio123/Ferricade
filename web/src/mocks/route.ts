// How a mock route is declared. A route names its method and path from the
// contract (an undocumented pair does not compile), says who may call it, and
// answers through a responder typed from that operation's documented responses:
// a status or body the contract does not have for it is a compile error.
import { delay, http, HttpResponse, type HttpHandler } from 'msw'
import type { paths } from '../api/schema'
import { DEMO, type MockConfig } from './config'
import type { MockDB } from './db'
import type { Error as ErrorBody, User } from './fixtures/types'
import { OPERATIONS, type Method, type Path } from './operations'
import type { ErrorCode, Failure } from './validate'

/** The signed-in browser session. There is one: the mock serves one user at a time. */
export interface MockSession {
  userId: string | null
  mfaPassed: boolean
  totpEnrolled: boolean
  csrf: string
  loginFailures: number
  totpFailures: number
  csrfCounter: number
  /** Until when sign-in (or TOTP) is locked after repeated failures. */
  lockedUntil: number
  /** A TOTP secret was handed out and awaits its first code. */
  enrolling: boolean
}

/** The open event streams, for the tests' controls (controls.ts). */
export interface EventStreams {
  /** Ends each open stream. */
  closers: Set<() => void>
  /** New streams wait until this time (db.now()) before they open. */
  holdUntil: number
}

export interface MockHealthCheck {
  name: 'id-server' | 'relay' | 'client-api' | 'hbbs-online-query'
  ok: boolean
  detail: string
  target: string
  address: string
  reason: 'dns' | 'refused' | 'timeout' | 'unreachable' | 'other' | null
  since: string
}

export interface MockServerHealth {
  status: 'ok' | 'degraded' | 'unknown'
  checked_at: string | null
  checks: MockHealthCheck[]
}

export interface Env {
  db: MockDB
  config: MockConfig
  session: MockSession
  streams: EventStreams
  offlineUntil: number
  health: MockServerHealth
}

export function createEnv(db: MockDB, config: MockConfig): Env {
  const user = db.users.find((u) => u.role === config.role && u.status === 'active')
  if (config.session === 'optional' && user) {
    user.totp_required = false
    db.totpEnrolled.delete(user.id)
  }
  if (config.role === 'user' && config.grants === 'none' && user)
    db.grants.set(user.id, { group_ids: [], device_ids: [] })
  const signedIn =
    !config.setupIncomplete &&
    user &&
    config.session !== 'signed-out' &&
    config.session !== 'optional'
  const session: MockSession = {
    userId: signedIn ? user.id : null,
    mfaPassed: config.session === 'signed-in',
    totpEnrolled: config.session !== 'enroll' && config.session !== 'optional',
    csrf: 'mock-csrf-0',
    loginFailures: 0,
    totpFailures: 0,
    csrfCounter: 0,
    lockedUntil: 0,
    enrolling: false,
  }
  const startedAt = new Date(db.now()).toISOString()
  const idHost = db.server?.id_host ?? 'rd.example.com'
  const relayHost = db.server?.relay_host ?? 'rd.example.com'
  const hostWithPort = (host: string, port: string) =>
    /:\d+$/.test(host) ? host : `${host}:${port}`
  const checks: MockHealthCheck[] = [
    {
      name: 'id-server',
      ok: true,
      detail: '',
      target: hostWithPort(idHost, '21116'),
      address: '203.0.113.10:21116',
      reason: null,
      since: startedAt,
    },
    {
      name: 'relay',
      ok: true,
      detail: '',
      target: hostWithPort(relayHost, '21117'),
      address: '203.0.113.10:21117',
      reason: null,
      since: startedAt,
    },
    {
      name: 'client-api',
      ok: true,
      detail: '',
      target: `${idHost.replace(/:\d+$/, '')}:21114`,
      address: '203.0.113.10:21114',
      reason: null,
      since: startedAt,
    },
    {
      name: 'hbbs-online-query',
      ok: true,
      detail: '',
      target: hostWithPort(idHost, '21116'),
      address: '',
      reason: null,
      since: startedAt,
    },
  ]
  return {
    db,
    config,
    session,
    streams: { closers: new Set(), holdUntil: 0 },
    offlineUntil: 0,
    health: { status: 'ok', checked_at: startedAt, checks },
  }
}

/** Replaces the CSRF token, as every login, TOTP step and password change does. */
export function rotateCsrf(env: Env): string {
  env.session.csrfCounter++
  env.session.csrf = `mock-csrf-${env.session.csrfCounter}`
  return env.session.csrf
}

// ---- typing from the contract --------------------------------------------------

type PathsWith<M extends Method> = {
  [P in Path]: paths[P] extends { [K in M]: object } ? P : never
}[Path]
type Responses<P extends Path, M extends Method> = paths[P] extends {
  [K in M]: { responses: infer R }
}
  ? R
  : never
type JsonStatus<R> = {
  [S in keyof R]: R[S] extends { content: { 'application/json': unknown } } ? S : never
}[keyof R] &
  number
type EmptyStatus<R> = { [S in keyof R]: R[S] extends { content: unknown } ? never : S }[keyof R] &
  number
type BodyOf<R, S extends keyof R> = R[S] extends { content: { 'application/json': infer B } }
  ? B
  : never

/** The JSON request body the contract documents for an operation. */
export type Body<P extends Path, M extends Method> = paths[P] extends {
  [K in M]: { requestBody: { content: { 'application/json': infer B } } }
}
  ? B
  : never

export interface Responder<R> {
  /** A JSON response; status and body must be documented for this operation. */
  <S extends JsonStatus<R>>(status: S, body: BodyOf<R, S>): Response
  /** A documented response without a body (204). */
  empty<S extends EmptyStatus<R>>(status: S): Response
  /** A documented error: {"error":{"code","message"}}. */
  error<S extends JsonStatus<R>>(status: S, code: ErrorCode, message: string): Response
  /** A failed Result from the db. The contract test checks its status is documented. */
  failure(f: Failure): Response
}

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

function json(status: number, body: unknown): Response {
  return new HttpResponse(JSON.stringify(body), { status, headers: HEADERS })
}

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  requestId?: string,
): Response {
  const body: ErrorBody = {
    error: { code, message, ...(requestId ? { request_id: requestId } : {}) },
  }
  return json(status, body)
}

function responder<R>(): Responder<R> {
  const respond = (status: number, body: unknown) => json(status, body)
  respond.empty = (status: number) =>
    new HttpResponse(null, { status, headers: { 'Cache-Control': 'no-store' } })
  respond.error = (status: number, code: ErrorCode, message: string) =>
    errorResponse(status, code, message)
  respond.failure = (f: Failure) => errorResponse(f.status, f.code, f.message)
  return respond as Responder<R>
}

// ---- who may call ----------------------------------------------------------------

/**
 * public: no session. setup: the setup token, while setup is open. session: a
 * session (CSRF checked). enroll: a session that may enroll TOTP. mfa: a session
 * that is fully signed in. staff: mfa, and the Owner or Admin role. owner: mfa, and the
 * Owner role.
 */
export type Policy = 'public' | 'setup' | 'session' | 'enroll' | 'mfa' | 'staff' | 'owner'
type SessionPolicy = Exclude<Policy, 'public' | 'setup'>

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Applies a policy to a request: a Response to send back, or the signed-in user (null for public and setup). */
export function authorize(
  env: Env,
  policy: Policy,
  request: Request,
): Response | { user: User | null } {
  const { db, session } = env
  if (db.now() < env.offlineUntil) return HttpResponse.error()
  if (policy === 'public') return { user: null }
  if (policy === 'setup') {
    if (db.setup.complete) return errorResponse(404, 'not_found', 'setup is already complete')
    if (request.headers.get('X-Setup-Token') !== DEMO.setupToken) {
      return errorResponse(401, 'unauthenticated', 'a valid X-Setup-Token is required')
    }
    return { user: null }
  }
  const user = session.userId ? db.findUser(session.userId) : undefined
  if (!user) return errorResponse(401, 'unauthenticated', 'sign in first')
  if (UNSAFE.has(request.method) && request.headers.get('X-CSRF-Token') !== session.csrf) {
    return errorResponse(403, 'csrf', 'missing or wrong X-CSRF-Token')
  }
  if (policy === 'session') return { user }
  if (policy === 'enroll') {
    if (session.totpEnrolled && !session.mfaPassed)
      return errorResponse(403, 'mfa_required', 'pass TOTP first')
    return { user }
  }
  if (!session.mfaPassed) {
    if (session.totpEnrolled) return errorResponse(403, 'mfa_required', 'pass TOTP first')
    if (user.totp_required) return errorResponse(403, 'totp_enroll_required', 'enroll TOTP first')
  }
  if (policy === 'owner' && user.role !== 'owner')
    return errorResponse(403, 'forbidden', 'not allowed for your role')
  if (policy === 'staff' && user.role === 'user')
    return errorResponse(403, 'forbidden', 'not allowed for your role')
  return { user }
}

// ---- declaring routes ----------------------------------------------------------------

export interface Ctx<R> {
  request: Request
  url: URL
  /** Path parameters ({id}, {alert_id}). */
  params: Record<string, string>
  respond: Responder<R>
  env: Env
  db: MockDB
}
export type AuthedCtx<R> = Ctx<R> & { actor: User }

const mswPath = (path: string) => path.replace(/\{(\w+)\}/g, ':$1')

export function operationId(method: Method, path: Path): string {
  const found = OPERATIONS.find((o) => o.method === method && o.path === path)
  if (!found) throw new Error(`mock: ${method} ${path} is not in operations.ts`)
  return found.id
}

export function route<P extends PathsWith<M>, M extends Method>(
  env: Env,
  policy: 'public' | 'setup',
  method: M,
  path: P,
  handler: (ctx: Ctx<Responses<P, M>>) => Response | Promise<Response>,
): HttpHandler
export function route<P extends PathsWith<M>, M extends Method>(
  env: Env,
  policy: SessionPolicy,
  method: M,
  path: P,
  handler: (ctx: AuthedCtx<Responses<P, M>>) => Response | Promise<Response>,
): HttpHandler
export function route<P extends PathsWith<M>, M extends Method>(
  env: Env,
  policy: Policy,
  method: M,
  path: P,
  handler: (ctx: AuthedCtx<Responses<P, M>>) => Response | Promise<Response>,
): HttpHandler {
  const id = operationId(method, path)
  return http[method](mswPath(path), async ({ request, params }) => {
    if (env.config.delayMs > 0) await delay(env.config.delayMs)
    if (env.config.failOperations.has(id)) {
      return errorResponse(500, 'internal', `mock-fail: ${id}`, 'mock-request-id')
    }
    const gate = authorize(env, policy, request)
    if (gate instanceof Response) return gate
    const flat: Record<string, string> = {}
    for (const [k, v] of Object.entries(params))
      flat[k] = Array.isArray(v) ? (v[0] ?? '') : String(v)
    return handler({
      request,
      url: new URL(request.url),
      params: flat,
      respond: responder<Responses<P, M>>(),
      env,
      db: env.db,
      // Public and setup routes never read it; every other policy has a user here.
      actor: gate.user as User,
    })
  })
}
