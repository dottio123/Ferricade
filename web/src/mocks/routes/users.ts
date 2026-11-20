// Users (Owner only) and the server profile.
import { http, HttpResponse, type HttpHandler } from 'msw'
import {
  clientAPITarget,
  createUser,
  patchServer,
  patchUser,
  resetUserPassword,
  resetUserTotp,
} from '../accounts'
import { clientConfigFor } from '../fixtures/server'
import { authorize, errorResponse, route, type Body, type Env } from '../route'
import { arr, bool, paginate, readBody, str, req } from '../validate'

const V1 = '/admin/api/v1'
const ROLES = ['owner', 'admin', 'user'] as const

export function userRoutes(env: Env): HttpHandler[] {
  const { db } = env
  const byId = `${V1}/users/{id}` as const

  return [
    http.get(`${V1}/auth/oidc/start`, ({ request }) =>
      HttpResponse.redirect(new URL('/sign-in?sso_error=provider_error', request.url), 302),
    ),
    http.get(`${V1}/auth/oidc/callback`, ({ request }) =>
      HttpResponse.redirect(new URL('/sign-in?sso_error=provider_error', request.url), 302),
    ),
    http.get(`${V1}/users/:id/avatar`, () =>
      HttpResponse.json(
        { error: { code: 'not_found', message: 'avatar not found' } },
        { status: 404 },
      ),
    ),
    http.delete(`${V1}/users/:id/oidc`, ({ request, params }) => {
      const gate = authorize(env, 'owner', request)
      if (gate instanceof Response) return gate
      const user = db.findUser(String(params.id))
      if (!user)
        return HttpResponse.json(
          { error: { code: 'not_found', message: 'user not found' } },
          { status: 404 },
        )
      if (!db.passwords.has(user.id))
        return HttpResponse.json(
          { error: { code: 'no_password', message: 'user has no password' } },
          { status: 409 },
        )
      user.sso = false
      db.record(
        db.users.find((u) => u.role === 'owner')!,
        'user.oidc_unlinked',
        'user',
        user.id,
      )
      return HttpResponse.json(user)
    }),
    route(env, 'owner', 'get', `${V1}/users`, ({ url, respond }) => {
      const sorted = [...db.users].sort((a, b) =>
        a.username.toLowerCase().localeCompare(b.username.toLowerCase()),
      )
      const page = paginate(sorted, url.searchParams)
      return page.ok ? respond(200, page.value) : respond.failure(page)
    }),

    route(env, 'owner', 'post', `${V1}/users`, async ({ request, respond, actor }) => {
      const body = await readBody<Body<`${typeof V1}/users`, 'post'>>(request, {
        username: req(str()),
        password: req(str()),
        display_name: str({ max: 128 }),
        email: str({ format: 'email' }),
        role: req(str({ values: ROLES })),
        totp_required: bool(),
      })
      if (!body.ok) return respond.failure(body)
      const r = createUser(db, body.value, actor)
      return r.ok ? respond(201, r.value) : respond.failure(r)
    }),

    route(env, 'owner', 'patch', byId, async ({ request, params, respond, actor }) => {
      const body = await readBody<Body<typeof byId, 'patch'>>(request, {
        display_name: str({ max: 128 }),
        email: str({ format: 'email' }),
        role: str({ values: ROLES }),
        status: str({ values: ['active', 'disabled'] }),
        totp_required: bool(),
      })
      if (!body.ok) return respond.failure(body)
      const previousRole = db.findUser(params.id ?? '')?.role
      const r = patchUser(db, params.id ?? '', body.value, actor)
      if (
        r.ok &&
        previousRole !== r.value.role &&
        (previousRole === 'user' || r.value.role === 'user')
      )
        db.grants.delete(r.value.id)
      return r.ok ? respond(200, r.value) : respond.failure(r)
    }),

    http.get(`${V1}/users/:id/grants`, ({ request, params }) => {
      const gate = authorize(env, 'owner', request)
      if (gate instanceof Response) return gate
      const user = db.findUser(String(params.id))
      if (!user) return errorResponse(404, 'not_found', 'user not found')
      return HttpResponse.json(
        user.role === 'user' ? db.grantsFor(user.id) : { group_ids: [], device_ids: [] },
      )
    }),
    http.put(`${V1}/users/:id/grants`, async ({ request, params }) => {
      const gate = authorize(env, 'owner', request)
      if (gate instanceof Response) return gate
      const body = await readBody<Body<`${typeof V1}/users/{id}/grants`, 'put'>>(request, {
        group_ids: req(arr(str({ format: 'uuid' }), { max: 256, unique: true })),
        device_ids: req(arr(str({ format: 'uuid' }), { max: 256, unique: true })),
      })
      if (!body.ok) return errorResponse(body.status, body.code, body.message)
      const result = db.replaceGrants(String(params.id), body.value, gate.user!)
      return result.ok
        ? HttpResponse.json(result.value)
        : errorResponse(result.status, result.code, result.message)
    }),

    route(env, 'owner', 'post', `${V1}/users/{id}/reset-totp`, ({ params, respond, actor }) => {
      const r = resetUserTotp(db, params.id ?? '', actor)
      if (r.ok) db.totpEnrolled.delete(r.value.id)
      return r.ok ? respond(200, r.value) : respond.failure(r)
    }),

    route(
      env,
      'owner',
      'post',
      `${V1}/users/{id}/password`,
      async ({ request, params, respond, actor }) => {
        const body = await readBody<Body<`${typeof V1}/users/{id}/password`, 'post'>>(request, {
          password: req(str()),
        })
        if (!body.ok) return respond.failure(body)
        const r = resetUserPassword(db, params.id ?? '', body.value.password, actor)
        return r.ok ? respond(200, r.value) : respond.failure(r)
      },
    ),
  ]
}

export function serverRoutes(env: Env): HttpHandler[] {
  const { db } = env

  return [
    route(env, 'staff', 'get', `${V1}/server`, ({ respond }) =>
      db.server
        ? respond(200, db.server)
        : respond.error(404, 'not_found', 'no server profile yet'),
    ),

    route(env, 'owner', 'patch', `${V1}/server`, async ({ request, respond, actor }) => {
      const body = await readBody<Body<`${typeof V1}/server`, 'patch'>>(request, {
        name: str({ max: 128 }),
        id_host: str(),
        relay_host: str(),
        public_key: str(),
        api_url: str(),
        links_include_server: bool(),
      })
      if (!body.ok) return respond.failure(body)
      const r = patchServer(db, body.value, actor)
      return r.ok ? respond(200, r.value) : respond.failure(r)
    }),

    route(env, 'staff', 'post', `${V1}/server/check`, ({ respond }) => {
      if (!db.server) return respond.error(404, 'not_found', 'no server profile yet')
      const now = new Date(db.now()).toISOString()
      const checks = env.health.checks.map((check) =>
        check.name === 'client-api' ? { ...check, target: clientAPITarget(db.server!) } : check,
      )
      env.health = { ...env.health, checked_at: now, checks }
      return respond(200, {
        checks: checks.map(({ name, ok, detail, target, address, reason }) => ({
          name,
          ok,
          detail,
          target,
          address,
          reason,
        })),
      })
    }),

    route(env, 'mfa', 'get', `${V1}/server/health`, ({ respond, actor }) =>
      respond(200, {
        ...env.health,
        checks: env.health.checks.map((check) => ({
          ...check,
          detail: actor.role === 'user' ? '' : check.detail,
          target:
            actor.role === 'user'
              ? ''
              : check.name === 'client-api' && db.server
                ? clientAPITarget(db.server)
                : check.target,
          address: actor.role === 'user' ? '' : check.address,
        })),
      }),
    ),

    route(env, 'staff', 'get', `${V1}/server/client-config`, ({ respond }) =>
      db.server
        ? respond(200, clientConfigFor(db.server))
        : respond.error(404, 'not_found', 'setup is not complete'),
    ),
  ]
}
