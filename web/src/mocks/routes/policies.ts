import type { HttpHandler } from 'msw'
import type { components } from '../../api/schema'
import catalogText from '../../../../internal/deploy/catalog.json?raw'
import { route, type Env } from '../route'
import { isUuid } from '../validate'
import { hasPermission } from '../permissions'

const V1 = '/admin/api/v1'
type Settings = components['schemas']['PolicySettings']
type CatalogSetting = { key: string; type: string; values?: string[] }
const catalog = new Map(
  (JSON.parse(catalogText) as CatalogSetting[]).map((setting) => [setting.key, setting]),
)

function object(
  raw: unknown,
  fields: string[],
): { value: Record<string, unknown> } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { error: 'body must be an object' }
  const value = raw as Record<string, unknown>
  const unknown = Object.keys(value).find((key) => !fields.includes(key))
  return unknown ? { error: `unknown field ${unknown}` } : { value }
}

async function read(request: Request, fields: string[]) {
  try {
    return object(await request.json(), fields)
  } catch {
    return { error: 'the request body is not valid JSON' }
  }
}

function settings(raw: unknown): { value: Settings } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { error: 'settings: must be an object' }
  const value = raw as Record<string, unknown>
  for (const key of Object.keys(value).sort()) {
    const setting = catalog.get(key)
    if (!setting) return { error: `${key}: not a catalog setting` }
    const entry = value[key]
    if (typeof entry !== 'string') return { error: `${key}: not an allowed value` }
    if (setting.type === 'bool' ? entry !== 'Y' && entry !== 'N' : !setting.values?.includes(entry))
      return { error: `${key}: not an allowed value` }
  }
  for (const key of ['approve-mode', 'verification-method'])
    if (!(key in value)) return { error: `${key}: required` }
  if (hasPermission(value) && ['full', 'view'].includes(value['access-mode'] as string))
    return { error: 'access-mode: must be custom when individual permissions are managed' }
  return { value: value as Settings }
}

function name(raw: unknown): raw is string {
  return typeof raw === 'string' && [...raw].length >= 1 && [...raw].length <= 100
}

export function policyRoutes(env: Env): HttpHandler[] {
  const { db } = env
  const base = `${V1}/policies` as const
  const byId = `${V1}/policies/{id}` as const
  const push = `${V1}/settings/policy-push` as const
  const group = `${V1}/groups/{id}/policy` as const
  const devicePolicy = `${V1}/devices/{id}/policy` as const
  const accessWindow = `${V1}/devices/{id}/access-window` as const
  const closeWindow = `${V1}/devices/{id}/access-window/close` as const
  return [
    route(env, 'mfa', 'get', devicePolicy, ({ params, respond, actor }) => {
      const id = params.id ?? ''
      if (actor.role === 'user' && !db.visibleDeviceIds(actor.id).has(id))
        return respond.error(404, 'not_found', 'not found')
      const result = db.devicePolicyStatus(id)
      if (!result.ok) return respond.failure(result)
      if (actor.role !== 'user') return respond(200, result.value)
      const sourceGroup = result.value.source_group
      return respond(200, {
        ...result.value,
        source_group:
          sourceGroup && db.visibleGroupIds(actor.id).has(sourceGroup.id) ? sourceGroup : null,
        window: result.value.window ? { ...result.value.window, opened_by: null } : null,
      })
    }),
    route(env, 'staff', 'post', accessWindow, async ({ params, request, respond, actor }) => {
      const body = await read(request, ['duration_minutes', 'disconnect_on_close'])
      if ('error' in body) return respond.error(400, 'bad_request', body.error)
      const duration = body.value.duration_minutes
      if (
        !('duration_minutes' in body.value) ||
        (duration !== null && (typeof duration !== 'number' || ![60, 240, 480].includes(duration)))
      )
        return respond.error(400, 'bad_request', 'duration_minutes: not an allowed value')
      if (typeof body.value.disconnect_on_close !== 'boolean')
        return respond.error(400, 'bad_request', 'disconnect_on_close is required')
      const result = db.openAccessWindow(
        params.id ?? '',
        duration as number | null,
        body.value.disconnect_on_close,
        actor,
      )
      return result.ok ? respond(201, result.value) : respond.failure(result)
    }),
    route(env, 'staff', 'post', closeWindow, async ({ params, request, respond, actor }) => {
      const body = await read(request, ['disconnect'])
      if ('error' in body) return respond.error(400, 'bad_request', body.error)
      if (typeof body.value.disconnect !== 'boolean')
        return respond.error(400, 'bad_request', 'disconnect is required')
      const result = db.closeAccessWindow(params.id ?? '', body.value.disconnect, actor)
      return result.ok ? respond.empty(204) : respond.failure(result)
    }),
    route(env, 'staff', 'get', base, ({ respond }) => respond(200, { items: db.listPolicies() })),
    route(env, 'staff', 'post', base, async ({ request, respond, actor }) => {
      const body = await read(request, ['name', 'settings'])
      if ('error' in body) return respond.error(400, 'bad_request', body.error)
      if (!name(body.value.name))
        return respond.error(400, 'bad_request', 'name: must contain 1 to 100 characters')
      const parsed = settings(body.value.settings)
      if ('error' in parsed) return respond.error(400, 'bad_request', parsed.error)
      const result = db.createPolicy(body.value.name, parsed.value, actor)
      return result.ok ? respond(201, result.value) : respond.failure(result)
    }),
    route(env, 'staff', 'get', byId, ({ params, respond }) => {
      const result = db.getPolicy(params.id ?? '')
      return result.ok ? respond(200, result.value) : respond.failure(result)
    }),
    route(env, 'staff', 'patch', byId, async ({ request, params, respond, actor }) => {
      const body = await read(request, ['name', 'settings'])
      if ('error' in body) return respond.error(400, 'bad_request', body.error)
      if (!('name' in body.value) && !('settings' in body.value))
        return respond.error(400, 'bad_request', 'name or settings is required')
      if ('name' in body.value && !name(body.value.name))
        return respond.error(400, 'bad_request', 'name: must contain 1 to 100 characters')
      let nextSettings: Settings | undefined
      if ('settings' in body.value) {
        const parsed = settings(body.value.settings)
        if ('error' in parsed) return respond.error(400, 'bad_request', parsed.error)
        nextSettings = parsed.value
      }
      const result = db.updatePolicy(
        params.id ?? '',
        body.value.name as string | undefined,
        nextSettings,
        actor,
      )
      return result.ok ? respond(200, result.value) : respond.failure(result)
    }),
    route(env, 'staff', 'delete', byId, ({ params, respond, actor }) => {
      const result = db.deletePolicy(params.id ?? '', actor)
      return result.ok ? respond.empty(204) : respond.failure(result)
    }),
    route(env, 'staff', 'get', push, ({ respond }) => respond(200, db.policyPush)),
    route(env, 'owner', 'put', push, async ({ request, respond, actor }) => {
      const body = await read(request, ['enabled'])
      if ('error' in body) return respond.error(400, 'bad_request', body.error)
      if (typeof body.value.enabled !== 'boolean')
        return respond.error(400, 'bad_request', 'enabled is required')
      const result = db.setPolicyPush(body.value.enabled, actor)
      return result.ok ? respond(200, result.value) : respond.failure(result)
    }),
    route(env, 'staff', 'put', group, async ({ request, params, respond, actor }) => {
      const body = await read(request, ['policy_id'])
      if ('error' in body) return respond.error(400, 'bad_request', body.error)
      if (
        !('policy_id' in body.value) ||
        (body.value.policy_id !== null && !isUuid(body.value.policy_id))
      )
        return respond.error(400, 'bad_request', 'policy_id must be a UUID or null')
      const result = db.setGroupPolicy(
        params.id ?? '',
        body.value.policy_id as string | null,
        actor,
      )
      return result.ok ? respond(200, result.value) : respond.failure(result)
    }),
  ]
}
