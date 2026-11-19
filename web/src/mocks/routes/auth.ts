import type { HttpHandler } from 'msw'
import { DEMO } from '../config'
import { passwordProblem } from '../accounts'
import { route, rotateCsrf, type Body, type Env } from '../route'
import { readBody, req, str } from '../validate'

const V1 = '/admin/api/v1'
const LOCK_MS = 60_000
const MAX_FAILURES = 5
const CODE = { code: req(str({ pattern: /^[0-9]{6}$/ })) }
const otpauthUrl = (username: string) =>
  `otpauth://totp/ferricade:${username}?secret=${DEMO.totpSecret}&issuer=ferricade`

export function authRoutes(env: Env): HttpHandler[] {
  const { db, session } = env

  /** Counts a failure and says whether the account is now locked. */
  function failed(counter: 'loginFailures' | 'totpFailures'): boolean {
    session[counter]++
    if (session[counter] >= MAX_FAILURES) {
      session.lockedUntil = db.now() + LOCK_MS
      session[counter] = 0
      return true
    }
    return false
  }
  const locked = () => db.now() < session.lockedUntil

  return [
    route(env, 'public', 'post', `${V1}/auth/login`, async ({ request, respond }) => {
      const body = await readBody<Body<`${typeof V1}/auth/login`, 'post'>>(request, {
        username: req(str()),
        password: req(str()),
      })
      if (!body.ok) return respond.failure(body)
      if (locked())
        return respond.error(423, 'locked', 'too many failed attempts; try again in a minute')
      const user = db.findUserByName(body.value.username)
      if (!user || user.status !== 'active' || db.passwords.get(user.id) !== body.value.password) {
        db.record(null, 'auth.login_failed', 'user', body.value.username)
        return failed('loginFailures')
          ? respond.error(423, 'locked', 'too many failed attempts; try again in a minute')
          : respond.error(401, 'unauthenticated', 'wrong username or password')
      }
      session.loginFailures = 0
      const enrolled = db.totpEnrolled.has(user.id)
      Object.assign(session, {
        userId: user.id,
        totpEnrolled: enrolled,
        mfaPassed: !enrolled && !user.totp_required,
        enrolling: false,
      })
      db.record(user, 'auth.login', 'user', user.id)
      return respond(200, {
        mfa_required: enrolled || user.totp_required,
        csrf_token: rotateCsrf(env),
      })
    }),

    route(env, 'public', 'get', `${V1}/auth/oidc`, ({ respond }) =>
      respond(200, { enabled: env.config.oidc, display_name: env.config.oidc ? 'Authentik' : '' }),
    ),

    route(env, 'session', 'post', `${V1}/auth/logout`, ({ respond, actor }) => {
      db.record(actor, 'auth.logout', 'user', actor.id)
      session.userId = null
      return respond.empty(204)
    }),

    route(env, 'session', 'get', `${V1}/auth/me`, ({ respond, actor }) =>
      respond(200, {
        user: actor,
        mfa_passed: session.mfaPassed,
        totp_enrolled: session.totpEnrolled,
        csrf_token: session.csrf,
      }),
    ),

    route(env, 'session', 'post', `${V1}/auth/totp`, async ({ request, respond, actor }) => {
      const body = await readBody<Body<`${typeof V1}/auth/totp`, 'post'>>(request, CODE)
      if (!body.ok) return respond.failure(body)
      if (!session.totpEnrolled)
        return respond.error(400, 'bad_request', 'TOTP is not set up for this account')
      if (locked())
        return respond.error(423, 'locked', 'too many wrong codes; try again in a minute')
      if (body.value.code === DEMO.usedTotpCode) {
        return respond.error(
          400,
          'code_already_used',
          'that code was already used; wait for the next one',
        )
      }
      if (body.value.code !== DEMO.totpCode) {
        return failed('totpFailures')
          ? respond.error(423, 'locked', 'too many wrong codes; try again in a minute')
          : respond.error(400, 'invalid_code', 'that code is not right')
      }
      session.totpFailures = 0
      session.mfaPassed = true
      db.record(actor, 'auth.mfa_passed', 'user', actor.id)
      return respond(200, { csrf_token: rotateCsrf(env) })
    }),

    route(env, 'mfa', 'post', `${V1}/auth/password`, async ({ request, respond, actor }) => {
      const body = await readBody<Body<`${typeof V1}/auth/password`, 'post'>>(request, {
        current_password: req(str()),
        new_password: req(str()),
      })
      if (!body.ok) return respond.failure(body)
      if (db.passwords.get(actor.id) !== body.value.current_password) {
        return respond.error(403, 'forbidden', 'the current password is wrong')
      }
      const weak = passwordProblem(body.value.new_password, actor.username)
      if (weak) return respond.error(400, 'weak_password', weak)
      db.passwords.set(actor.id, body.value.new_password)
      db.record(actor, 'auth.password_changed', 'user', actor.id)
      return respond(200, { csrf_token: rotateCsrf(env) })
    }),

    route(env, 'enroll', 'post', `${V1}/auth/totp/enroll`, ({ respond, actor }) => {
      session.enrolling = true
      return respond(200, { secret: DEMO.totpSecret, otpauth_url: otpauthUrl(actor.username) })
    }),

    route(
      env,
      'enroll',
      'post',
      `${V1}/auth/totp/enroll/verify`,
      async ({ request, respond, actor }) => {
        const body = await readBody<Body<`${typeof V1}/auth/totp/enroll/verify`, 'post'>>(
          request,
          CODE,
        )
        if (!body.ok) return respond.failure(body)
        if (!session.enrolling) return respond.error(409, 'incomplete', 'start enrollment first')
        if (body.value.code === DEMO.usedTotpCode) {
          return respond.error(
            400,
            'code_already_used',
            'that code was already used; wait for the next one',
          )
        }
        if (body.value.code !== DEMO.totpCode)
          return respond.error(400, 'invalid_code', 'that code is not right')
        session.enrolling = false
        session.totpEnrolled = true
        session.mfaPassed = true
        db.totpEnrolled.add(actor.id)
        db.record(actor, 'auth.totp_enrolled', 'user', actor.id)
        return respond(200, { csrf_token: rotateCsrf(env) })
      },
    ),
  ]
}
