import type { HttpHandler } from 'msw'
import type { components } from '../../api/schema'
import catalogText from '../../../../internal/deploy/catalog.json?raw'
import { route, type Env } from '../route'
import { hasPermission } from '../permissions'

const V1 = '/admin/api/v1'
type Schemas = components['schemas']
type Profile = Schemas['DeploymentProfile']
type Put = Schemas['DeploymentProfilePut']
type SecretState = Schemas['DeploymentSecretState']

const catalog: Schemas['DeploymentSetting'][] = (
  JSON.parse(catalogText) as Array<Schemas['DeploymentSetting'] & { lock: boolean }>
).map((entry) => ({
  key: entry.key,
  label: entry.label,
  help: entry.help,
  type: entry.type,
  values: entry.values ?? [],
  value_labels: entry.value_labels,
  default: entry.default,
  os: entry.os,
  source: entry.source,
}))

const unset = (): SecretState => ({ set: false, set_at: null, set_by: null })

const defaults = (): Profile => ({
  installer_source: 'github',
  client_version: 'latest',
  url_windows: '',
  url_deb: '',
  url_rpm: '',
  sha256_windows: '',
  sha256_deb: '',
  sha256_rpm: '',
  allow_downgrade: false,
  include_install: true,
  include_password: false,
  include_unlock_pin: false,
  include_id_allow_list: false,
  settings: {},
  catalog,
  password: unset(),
  unlock_pin: unset(),
  updated_at: null,
})

const editableFields = [
  'installer_source',
  'client_version',
  'url_windows',
  'url_deb',
  'url_rpm',
  'sha256_windows',
  'sha256_deb',
  'sha256_rpm',
  'allow_downgrade',
  'include_install',
  'include_password',
  'include_unlock_pin',
  'include_id_allow_list',
  'settings',
] as const

function editable(
  profile: Profile,
): Omit<Profile, 'catalog' | 'password' | 'unlock_pin' | 'updated_at'> {
  const {
    catalog: _catalog,
    password: _password,
    unlock_pin: _pin,
    updated_at: _updated,
    ...rest
  } = profile
  void _catalog
  void _password
  void _pin
  void _updated
  return rest
}

function parsePut(raw: unknown): { value: Put } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { error: 'deployment profile must be an object' }
  const body = raw as Record<string, unknown>
  const allowed = new Set<string>([...editableFields, 'fleet_password', 'unlock_pin'])
  for (const key of Object.keys(body))
    if (!allowed.has(key)) return { error: `unknown field ${key}` }
  for (const key of editableFields) {
    if (!(key in body) || body[key] === null) return { error: `${key} is required` }
  }
  for (const key of [
    'installer_source',
    'client_version',
    'url_windows',
    'url_deb',
    'url_rpm',
    'sha256_windows',
    'sha256_deb',
    'sha256_rpm',
  ]) {
    if (typeof body[key] !== 'string') return { error: `${key} must be a string` }
  }
  for (const key of [
    'allow_downgrade',
    'include_install',
    'include_password',
    'include_unlock_pin',
    'include_id_allow_list',
  ]) {
    if (typeof body[key] !== 'boolean') return { error: `${key} must be a boolean` }
  }
  if (body.installer_source !== 'github' && body.installer_source !== 'url')
    return { error: 'installer_source must be github or url' }
  if (body.client_version === 'latest' && body.installer_source !== 'github')
    return { error: 'client_version: latest needs the GitHub installer source' }
  if (body.client_version !== 'latest' && !/^\d+\.\d+\.\d+$/.test(body.client_version as string))
    return { error: 'client_version must be major.minor.patch' }
  if (body.client_version === 'latest') {
    for (const key of ['sha256_windows', 'sha256_deb', 'sha256_rpm']) {
      if (body[key] !== '') return { error: `${key}: not allowed with the latest release` }
    }
  }
  for (const key of ['fleet_password', 'unlock_pin']) {
    if (key in body && body[key] !== null && typeof body[key] !== 'string')
      return { error: `${key} must be a string or null` }
  }
  if (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings))
    return { error: 'settings must be an object' }
  for (const [key, value] of Object.entries(body.settings as Record<string, unknown>)) {
    if (!catalog.some((entry) => entry.key === key))
      return { error: `settings.${key}: unknown setting` }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return { error: `settings.${key} must be an object` }
    const setting = value as Record<string, unknown>
    if (typeof setting.include !== 'boolean' || typeof setting.value !== 'string')
      return { error: `settings.${key} needs include and value` }
  }
  const included = Object.fromEntries(
    Object.entries(body.settings as Record<string, { include: boolean; value: string }>).filter(
      ([, entry]) => entry.include,
    ),
  )
  const accessMode = included['access-mode']?.value
  if (hasPermission(included) && (accessMode === 'full' || accessMode === 'view'))
    return { error: 'access-mode: must be custom when individual permissions are managed' }
  return { value: body as Put }
}

const STORAGE_KEY = 'ferricade-mock-deployment-profile'

function loadProfile(): Profile {
  if (typeof sessionStorage !== 'undefined') {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY)
      if (saved) return JSON.parse(saved) as Profile
    } catch {
      // ignore
    }
  }
  return defaults()
}

function saveProfile(p: Profile) {
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p))
    } catch {
      // ignore
    }
  }
}

export function deploymentRoutes(env: Env): HttpHandler[] {
  const { db } = env
  let profile = loadProfile()
  const path = `${V1}/deployment/profile` as const

  return [
    route(env, 'staff', 'get', path, ({ respond }) => respond(200, profile)),
    route(env, 'owner', 'put', path, async ({ request, respond, actor }) => {
      let raw: unknown
      try {
        raw = await request.json()
      } catch {
        return respond.error(400, 'bad_request', 'the request body is not valid JSON')
      }
      const parsed = parsePut(raw)
      if ('error' in parsed) return respond.error(400, 'bad_request', parsed.error)
      const { fleet_password, unlock_pin, ...changes } = parsed.value
      const before = editable(profile)
      const hadPassword = profile.password.set
      const hadPIN = profile.unlock_pin.set
      const at = new Date(db.now()).toISOString()
      const state = (prior: SecretState, change: string | null | undefined): SecretState =>
        change === undefined
          ? prior
          : change === null
            ? unset()
            : {
                set: true,
                set_at: at,
                set_by: { id: actor.id, display_name: actor.display_name },
              }
      const password = state(profile.password, fleet_password)
      const pin = state(profile.unlock_pin, unlock_pin)
      profile = { ...profile, ...changes, password, unlock_pin: pin, updated_at: at }
      saveProfile(profile)
      db.record(actor, 'deployment.profile_updated', 'settings', 'deployment', {
        before,
        after: editable(profile),
      })
      if (fleet_password !== undefined) {
        if (fleet_password !== null)
          db.record(actor, 'deployment.password_set', 'settings', 'deployment')
        else if (hadPassword)
          db.record(actor, 'deployment.password_removed', 'settings', 'deployment')
      }
      if (unlock_pin !== undefined) {
        if (unlock_pin !== null) db.record(actor, 'deployment.pin_set', 'settings', 'deployment')
        else if (hadPIN) db.record(actor, 'deployment.pin_removed', 'settings', 'deployment')
      }
      return respond(200, profile)
    }),
    route(env, 'staff', 'post', `${V1}/deployment/script`, async ({ request, respond, actor }) => {
      let raw: unknown
      try {
        raw = await request.json()
      } catch {
        return respond.error(400, 'bad_request', 'the request body is not valid JSON')
      }
      if (
        typeof raw !== 'object' ||
        raw === null ||
        Array.isArray(raw) ||
        Object.keys(raw).length !== 1 ||
        !('os' in raw) ||
        (raw.os !== 'windows' && raw.os !== 'linux')
      )
        return respond.error(400, 'bad_request', 'os must be windows or linux')
      if (!db.setup.complete || !db.server)
        return respond.error(404, 'not_found', 'no server profile yet')
      if (profile.installer_source === 'url') {
        if (raw.os === 'windows' && !profile.url_windows)
          return respond.error(400, 'bad_request', 'url_windows is required for windows')
        if (raw.os === 'linux' && !profile.url_deb && !profile.url_rpm)
          return respond.error(400, 'bad_request', 'url_deb or url_rpm is required for linux')
      }
      db.record(actor, 'deployment.script_downloaded', 'settings', 'deployment', { os: raw.os })
      const ext = raw.os === 'windows' ? '.ps1' : '.sh'
      return new Response('# ferricade deployment script\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename=ferricade-deploy${ext}`,
          'Cache-Control': 'no-store',
        },
      })
    }),
  ]
}
