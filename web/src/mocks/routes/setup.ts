import type { HttpHandler } from 'msw'
import { checkServer, passwordProblem, profileProblem, validUsername } from '../accounts'
import { DEMO } from '../config'
import { SERVER_ID, clientConfigFor } from '../fixtures/server'
import type { Server, User } from '../fixtures/types'
import { route, type Body, type Env } from '../route'
import { readBody, req, str } from '../validate'

export function setupRoutes(env: Env): HttpHandler[] {
  const { db } = env
  const otpauth = (username: string) =>
    `otpauth://totp/ferricade:${username}?secret=${DEMO.totpSecret}&issuer=ferricade`

  return [
    route(env, 'public', 'get', '/setup/status', ({ respond }) =>
      respond(200, { setup_complete: db.setup.complete, plain_http: env.config.plainHttp }),
    ),

    route(env, 'setup', 'post', '/setup/owner', async ({ request, respond }) => {
      const body = await readBody<Body<'/setup/owner', 'post'>>(request, {
        username: req(str()),
        password: req(str()),
        display_name: str({ max: 128 }),
        email: str({ format: 'email' }),
      })
      if (!body.ok) return respond.failure(body)
      const { username, password } = body.value
      if (!validUsername(username)) {
        return respond.error(
          400,
          'bad_request',
          "username: 1 to 64 of letters, digits, '.', '_', '-', '@'",
        )
      }
      const weak = passwordProblem(password, username)
      if (weak) return respond.error(400, 'weak_password', weak)
      // Repeating this step overwrites the same owner and restarts TOTP enrollment.
      const previous = db.users.find((u) => u.role === 'owner')
      const owner: User = {
        id: previous?.id ?? db.newId(),
        username,
        display_name: body.value.display_name ?? '',
        email: body.value.email ?? '',
        role: 'owner',
        status: 'active',
        totp_required: true,
        sso: false,
        avatar_url: null,
      }
      db.users = [...db.users.filter((u) => u.id !== owner.id), owner]
      db.passwords.set(owner.id, password)
      db.totpEnrolled.delete(owner.id)
      Object.assign(db.setup, { ownerCreated: true, totpGenerated: false, totpVerified: false })
      db.record(null, 'setup.owner_created', 'user', owner.id)
      return respond(201, { id: owner.id })
    }),

    route(env, 'setup', 'post', '/setup/owner/totp', ({ respond }) => {
      const owner = db.users.find((u) => u.role === 'owner')
      if (!db.setup.ownerCreated || !owner)
        return respond.error(409, 'incomplete', 'create the owner first')
      db.setup.totpGenerated = true
      db.setup.totpVerified = false
      return respond(200, { secret: DEMO.totpSecret, otpauth_url: otpauth(owner.username) })
    }),

    route(env, 'setup', 'post', '/setup/owner/totp/verify', async ({ request, respond }) => {
      const body = await readBody<Body<'/setup/owner/totp/verify', 'post'>>(request, {
        code: req(str({ pattern: /^[0-9]{6}$/ })),
      })
      if (!body.ok) return respond.failure(body)
      const owner = db.users.find((u) => u.role === 'owner')
      if (!db.setup.totpGenerated || !owner)
        return respond.error(409, 'incomplete', 'generate the secret first')
      if (body.value.code === DEMO.usedTotpCode) {
        return respond.error(
          400,
          'code_already_used',
          'that code was already used; wait for the next one',
        )
      }
      if (body.value.code !== DEMO.totpCode)
        return respond.error(400, 'invalid_code', 'that code is not right')
      db.setup.totpVerified = true
      db.totpEnrolled.add(owner.id)
      return respond(200, { verified: true })
    }),

    route(env, 'setup', 'post', '/setup/server', async ({ request, respond }) => {
      const body = await readBody<Body<'/setup/server', 'post'>>(request, {
        name: str({ max: 128 }),
        id_host: req(str()),
        relay_host: req(str()),
        public_key: req(str()),
      })
      if (!body.ok) return respond.failure(body)
      const profile = { ...body.value, name: body.value.name || 'default' }
      const problem = profileProblem(profile)
      if (!problem.ok) return respond.failure(problem)
      const at = new Date(db.now()).toISOString()
      const server: Server = db.server
        ? { ...db.server, ...profile, updated_at: at }
        : {
            id: SERVER_ID,
            ...profile,
            api_url: '',
            links_include_server: true,
            created_at: at,
            updated_at: at,
          }
      db.server = server
      db.setup.serverSaved = true
      return respond(200, { saved: true, server_id: server.id, checks: checkServer(server) })
    }),

    route(env, 'setup', 'post', '/setup/complete', ({ respond }) => {
      const s = db.setup
      if (!s.ownerCreated || !s.totpVerified || !s.serverSaved || !db.server) {
        return respond.error(
          409,
          'incomplete',
          'create the owner, verify TOTP and save the server first',
        )
      }
      s.complete = true
      db.record(null, 'setup.completed', 'server', db.server.id)
      return respond(200, { client_config: clientConfigFor(db.server) })
    }),
  ]
}
