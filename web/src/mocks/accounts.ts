// Rules for users, passwords, the server profile and connect links, as the
// backend enforces them. Functions over the MockDB so db.ts stays about state.
import type { components } from '../api/schema'
import type { MockDB } from './db'
import type { Device, Server, User } from './fixtures/types'
import { badRequest, fail, notFound, ok, type Result } from './validate'

type Check = components['schemas']['Check']

const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/
const COMMON_PASSWORDS = [
  'password1234',
  '123456789012',
  'qwertyuiop12',
  'iloveyou1234',
  'administrator',
]

/** At least 12 characters, not a common password, not the username. */
export function passwordProblem(password: string, username: string): string | null {
  if ([...password].length < 12) return 'the password must be at least 12 characters'
  if (COMMON_PASSWORDS.includes(password.toLowerCase())) return 'that password is too common'
  if (password.toLowerCase() === username.toLowerCase())
    return 'the password must not be the username'
  return null
}

export function validUsername(username: string): boolean {
  return USERNAME.test(username)
}

export function createUser(
  db: MockDB,
  input: {
    username: string
    password: string
    display_name?: string
    email?: string
    role: User['role']
    totp_required?: boolean
  },
  actor: User,
): Result<User> {
  if (!validUsername(input.username))
    return badRequest("username: 1 to 64 of letters, digits, '.', '_', '-', '@'")
  const weak = passwordProblem(input.password, input.username)
  if (weak) return fail(400, 'weak_password', weak)
  if (db.findUserByName(input.username))
    return fail(409, 'username_taken', 'that username is taken')
  const user: User = {
    id: db.newId(),
    username: input.username,
    display_name: input.display_name ?? '',
    email: input.email ?? '',
    role: input.role,
    status: 'active',
    totp_required: input.role === 'owner' ? true : (input.totp_required ?? false),
    sso: false,
    avatar_url: null,
  }
  db.users.push(user)
  db.passwords.set(user.id, input.password)
  db.record(actor, 'user.created', 'user', user.id, { username: user.username, role: user.role })
  return ok(user)
}

export function patchUser(
  db: MockDB,
  id: string,
  patch: Partial<Pick<User, 'display_name' | 'email' | 'role' | 'status' | 'totp_required'>>,
  actor: User,
): Result<User> {
  const user = db.findUser(id)
  if (!user) return notFound('user not found')
  const next = { ...user, ...patch }
  if (next.role === 'owner' && patch.totp_required === false) {
    return badRequest('an owner must use TOTP; totp_required cannot be false')
  }
  const activeOwners = db.users.filter((u) => u.role === 'owner' && u.status === 'active').length
  const wasOwner = user.role === 'owner' && user.status === 'active'
  const staysOwner = next.role === 'owner' && next.status === 'active'
  if (wasOwner && !staysOwner && activeOwners <= 1) {
    return fail(409, 'last_owner', 'this would leave no active owner')
  }
  if (next.role === 'owner') next.totp_required = true
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const key of ['display_name', 'email', 'role', 'status', 'totp_required'] as const) {
    if (user[key] !== next[key]) {
      before[key] = user[key]
      after[key] = next[key]
    }
  }
  Object.assign(user, next)
  db.record(actor, 'user.updated', 'user', user.id, { before, after })
  return ok(user)
}

export function resetUserTotp(db: MockDB, id: string, actor: User): Result<User> {
  const user = db.findUser(id)
  if (!user) return notFound('user not found')
  db.record(actor, 'user.totp_reset', 'user', user.id)
  return ok(user)
}

/** An owner sets another account's password; the server also ends its sessions and clears its lockout. */
export function resetUserPassword(
  db: MockDB,
  id: string,
  password: string,
  actor: User,
): Result<User> {
  if (new TextEncoder().encode(password).length > 1024)
    return badRequest('password must be at most 1024 bytes')
  if (id === actor.id) return badRequest('change your own password under User settings')
  const user = db.findUser(id)
  if (!user) return notFound('user not found')
  const weak = passwordProblem(password, user.username)
  if (weak) return fail(400, 'weak_password', weak)
  db.passwords.set(user.id, password)
  db.record(actor, 'user.password_reset', 'user', user.id)
  return ok(user)
}

// ---- server profile ------------------------------------------------------

const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:]+\])(?::(\d{1,5}))?$|^[0-9A-Fa-f:]+$/

export function hostProblem(field: string, host: string): string | null {
  const m = HOST.exec(host)
  if (!m) return `${field} must be a DNS name or IP address, optionally with :port`
  if (m[1] !== undefined && (Number(m[1]) < 1 || Number(m[1]) > 65535))
    return `${field}: the port must be 1-65535`
  return null
}

const API_URL_ERROR =
  'must be an https://host[:port] address without path, query, fragment or user info'

function apiURLProblem(value: string): string | null {
  if (value === '') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return API_URL_ERROR
  }
  const authority = /^https:\/\/([^/?#]*)/.exec(value)?.[1] ?? ''
  const rawPath = value.slice(`https://${authority}`.length)
  if (
    !value.startsWith('https://') ||
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username !== '' ||
    url.password !== '' ||
    authority.includes('@') ||
    value.includes('?') ||
    value.includes('#') ||
    (rawPath !== '' && rawPath !== '/')
  ) {
    return API_URL_ERROR
  }
  if (
    url.port !== '' &&
    (Number(url.port) < 1 || Number(url.port) > 65535 || Number(url.port) === 21114)
  )
    return 'port must be between 1 and 65535 and cannot be 21114'
  return null
}

export function clientAPITarget(server: Pick<Server, 'id_host' | 'api_url'>): string {
  if (server.api_url !== '') {
    const url = new URL(server.api_url)
    return `${url.hostname}:${url.port || '443'}`
  }
  return `${server.id_host.replace(/:\d+$/, '')}:21114`
}

/** Base64 of 32 bytes (hbbs's id_ed25519.pub). */
export function keyValid(key: string): boolean {
  try {
    return /^[A-Za-z0-9+/]+=*$/.test(key) && atob(key).length === 32
  } catch {
    return false
  }
}

export function profileProblem(p: {
  id_host: string
  relay_host: string
  public_key: string
  api_url?: string
}): Result<null> {
  const host = hostProblem('id_host', p.id_host) ?? hostProblem('relay_host', p.relay_host)
  if (host) return badRequest(host)
  if (!keyValid(p.public_key))
    return fail(400, 'invalid_key', 'public_key must be base64 of 32 bytes')
  if (p.api_url !== undefined) {
    const apiURL = apiURLProblem(p.api_url)
    if (apiURL) return badRequest(apiURL)
  }
  return ok(null)
}

export function patchServer(
  db: MockDB,
  patch: Partial<
    Pick<
      Server,
      'name' | 'id_host' | 'relay_host' | 'public_key' | 'api_url' | 'links_include_server'
    >
  >,
  actor: User,
): Result<Server> {
  const server = db.server
  if (!server) return notFound('no server profile yet')
  const next = { ...server, ...patch }
  if (next.name === '') next.name = 'default'
  const problem = profileProblem(next)
  if (!problem.ok) return problem
  if (next.api_url.endsWith('/')) next.api_url = next.api_url.slice(0, -1)
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const key of [
    'name',
    'id_host',
    'relay_host',
    'public_key',
    'api_url',
    'links_include_server',
  ] as const) {
    if (server[key] !== next[key]) {
      before[key] = server[key]
      after[key] = next[key]
    }
  }
  Object.assign(server, next, { updated_at: new Date(db.now()).toISOString() })
  db.record(actor, 'server.updated', 'server', server.id, { before, after })
  return ok(server)
}

/** The reachability checks. A host starting with "down." fails, so the UI's failed state can be seen. */
export function checkServer(server: Pick<Server, 'id_host' | 'relay_host' | 'api_url'>): Check[] {
  const down = (host: string) => host.startsWith('down.')
  const withPort = (host: string, port: string) => (/:\d+$/.test(host) ? host : `${host}:${port}`)
  const idTarget = withPort(server.id_host, '21116')
  const relayTarget = withPort(server.relay_host, '21117')
  const clientTarget = clientAPITarget(server)
  return [
    {
      name: 'id-server',
      ok: !down(server.id_host),
      detail: down(server.id_host) ? `dial tcp ${idTarget}: connect: connection refused` : '',
      target: idTarget,
      address: '203.0.113.10:21116',
      reason: down(server.id_host) ? 'refused' : null,
    },
    {
      name: 'relay',
      ok: !down(server.relay_host),
      detail: down(server.relay_host) ? `dial tcp ${relayTarget}: connect: connection refused` : '',
      target: relayTarget,
      address: '203.0.113.10:21117',
      reason: down(server.relay_host) ? 'refused' : null,
    },
    {
      name: 'client-api',
      ok: true,
      detail: '',
      target: clientTarget,
      address: '203.0.113.10:21114',
      reason: null,
    },
    {
      name: 'hbbs-online-query',
      ok: true,
      detail: '',
      target: idTarget,
      address: '',
      reason: null,
    },
  ]
}

// ---- connect links ----------------------------------------------------------

export type ConnectAction = 'connect' | 'file-transfer' | 'port-forward' | 'terminal'

/** rustdesk://[<action>/]<id>[/r]@<host>?key=<key>, and the matching command line. */
export function connectLink(
  server: Server,
  device: Pick<Device, 'rustdesk_id'>,
  action: ConnectAction,
  relay: boolean,
): { url: string; command: string; id: string; includes_server: boolean } {
  const target = device.rustdesk_id + (relay ? '/r' : '')
  const via = server.links_include_server ? `${target}@${server.id_host}` : target
  const url =
    (action === 'connect' ? `rustdesk://${via}` : `rustdesk://${action}/${via}`) +
    (server.links_include_server ? `?key=${encodeURIComponent(server.public_key)}` : '')
  return {
    url,
    command: server.links_include_server
      ? `rustdesk --${action} "${via}?key=${server.public_key}"`
      : `rustdesk --${action} ${via}`,
    id: device.rustdesk_id,
    includes_server: server.links_include_server,
  }
}
