import type { HttpHandler } from 'msw'
import { deviceName, deviceStatus } from '../../lib/device'
import { connectLink } from '../accounts'
import type { Device } from '../fixtures/types'
import { route, type Body, type Env } from '../route'
import { arr, badRequest, isUuid, paginate, readBody, str, type Result, req } from '../validate'

const V1 = '/admin/api/v1'
const STATES = ['pending', 'approved', 'rejected', 'archived'] as const
const ACTIONS = ['connect', 'file-transfer', 'port-forward', 'terminal'] as const
const SORTS = ['rustdesk_id', 'name', 'status', 'state', 'os', 'group'] as const
type Sort = (typeof SORTS)[number]

interface DeviceCursor {
  id: string
  sort: Sort
  order: string
  filters: string
}

function encodeCursor(cursor: DeviceCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function devicePage(
  items: Device[],
  query: URLSearchParams,
  env: Env,
  userId: string,
): Result<{ items: Device[]; next_cursor: string }> {
  const sort = SORTS.find((key) => key === (query.get('sort') ?? 'rustdesk_id'))
  const order = query.get('order') ?? 'asc'
  if (!sort) return badRequest('unknown sort')
  if (order !== 'asc' && order !== 'desc') return badRequest('unknown order')
  const filters = JSON.stringify([
    userId,
    ...['state', 'online', 'tag', 'group', 'subgroups', 'ungrouped', 'os', 'q'].map((key) =>
      query.get(key),
    ),
  ])
  const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0)
  const key = (d: Device): [number, string | number] => {
    switch (sort) {
      case 'name':
        return [0, deviceName(d).toLowerCase()]
      case 'status':
        return [0, ['alert', 'pending', 'online', 'offline'].indexOf(deviceStatus(d))]
      case 'state':
        return [0, STATES.indexOf(d.state)]
      case 'os':
        return [Number(d.os === ''), d.os.toLowerCase()]
      case 'group': {
        const group = env.db.groups.find((g) => g.id === d.group_id)
        return [Number(!group), group?.name.toLowerCase() ?? '']
      }
      default:
        return [0, d.rustdesk_id]
    }
  }
  const compare = (a: Device, b: Device) => {
    const ka = key(a),
      kb = key(b)
    return (
      (cmp(ka[0], kb[0]) ||
        cmp(ka[1], kb[1]) ||
        cmp(a.rustdesk_id, b.rustdesk_id) ||
        cmp(a.id, b.id)) * (order === 'desc' ? -1 : 1)
    )
  }
  let sorted = items.toSorted(compare)
  const value = query.get('cursor') ?? ''
  if (value) {
    let c: DeviceCursor
    try {
      const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
        char.charCodeAt(0),
      )
      c = JSON.parse(new TextDecoder().decode(bytes)) as DeviceCursor
      if (!c || !isUuid(c.id)) return badRequest('invalid cursor')
    } catch {
      return badRequest('invalid cursor')
    }
    if (c.sort !== sort || c.order !== order) return badRequest('cursor does not match sort')
    if (c.filters !== filters) return badRequest('cursor does not match filters')
    const after = sorted.find((d) => d.id === c.id)
    sorted = after ? sorted.filter((d) => compare(d, after) > 0) : []
  }
  const pageQuery = new URLSearchParams(query)
  pageQuery.delete('cursor')
  const result = paginate(sorted, pageQuery)
  if (!result.ok) return result
  const last = result.value.items.at(-1)
  return {
    ok: true,
    value: {
      items: result.value.items,
      next_cursor:
        result.value.next_cursor && last ? encodeCursor({ id: last.id, sort, order, filters }) : '',
    },
  }
}

interface Filter {
  state?: Device['state']
  online?: boolean
  tag?: string
  group?: string
  subgroups?: boolean
  ungrouped?: boolean
  os?: string
  q?: string
}

function parseFilter(query: URLSearchParams): Result<Filter> {
  const filter: Filter = {}
  const state = query.get('state')
  if (state !== null) {
    const found = STATES.find((s) => s === state)
    if (!found) return badRequest('state must be pending, approved, rejected or archived')
    filter.state = found
  }
  const online = query.get('online')
  if (online !== null) {
    if (online !== 'true' && online !== 'false') return badRequest('online must be true or false')
    filter.online = online === 'true'
  }
  const ungrouped = query.get('ungrouped')
  if (ungrouped !== null) {
    if (ungrouped !== 'true' && ungrouped !== 'false')
      return badRequest('ungrouped must be true or false')
    filter.ungrouped = ungrouped === 'true'
  }
  const subgroups = query.get('subgroups')
  if (subgroups !== null) {
    if (subgroups !== 'true' && subgroups !== 'false')
      return badRequest('subgroups must be true or false')
    filter.subgroups = subgroups === 'true'
  }
  for (const key of ['tag', 'group'] as const) {
    const v = query.get(key)
    if (v !== null) {
      if (!isUuid(v)) return badRequest(`${key} must be a UUID`)
      filter[key] = v
    }
  }
  if (subgroups !== null && (!filter.group || filter.ungrouped))
    return badRequest('subgroups requires group and cannot be combined with ungrouped')
  if (filter.ungrouped && filter.group) return badRequest('group and ungrouped cannot be combined')
  for (const key of ['os', 'q'] as const) {
    const v = query.get(key)
    if (v !== null) {
      if (v.length > 256) return badRequest(`${key} is too long`)
      filter[key] = v.toLowerCase()
    }
  }
  return { ok: true, value: filter }
}

function matches(d: Device, f: Filter, env: Env): boolean {
  if (f.state && d.state !== f.state) return false
  if (f.tag && !d.tags.some((t) => t.id === f.tag)) return false
  if (f.group) {
    const groupIDs = new Set([f.group])
    if (f.subgroups) {
      for (let grew = true; grew;) {
        grew = false
        for (const group of env.db.groups) {
          if (
            group.parent_id !== null &&
            groupIDs.has(group.parent_id) &&
            !groupIDs.has(group.id)
          ) {
            groupIDs.add(group.id)
            grew = true
          }
        }
      }
    }
    if (!d.group_id || !groupIDs.has(d.group_id)) return false
  }
  if (f.ungrouped && d.group_id !== null) return false
  if (f.os && !d.os.toLowerCase().startsWith(f.os)) return false
  if (f.q) {
    const hay = [d.rustdesk_id, d.alias, d.hostname, d.username].map((s) => s.toLowerCase())
    if (!hay.some((s) => s.includes(f.q!))) return false
  }
  return true
}

export function deviceRoutes(env: Env): HttpHandler[] {
  const { db } = env
  const byId = `${V1}/devices/{id}` as const

  function transition(
    path:
      | `${typeof V1}/devices/{id}/approve`
      | `${typeof V1}/devices/{id}/reject`
      | `${typeof V1}/devices/{id}/archive`
      | `${typeof V1}/devices/{id}/restore`
      | `${typeof V1}/devices/{id}/reopen`,
    action: 'approve' | 'reject' | 'archive' | 'restore' | 'reopen',
  ) {
    return route(env, 'staff', 'post', path, ({ params, respond, actor }) => {
      const r = db.transition(params.id ?? '', action, actor)
      return r.ok ? respond(200, r.value) : respond.failure(r)
    })
  }

  return [
    route(env, 'mfa', 'get', `${V1}/devices`, ({ url, respond, actor }) => {
      const filter = parseFilter(url.searchParams)
      if (!filter.ok) return respond.failure(filter)
      const visible = actor.role === 'user' ? db.visibleDeviceIds(actor.id) : null
      // As in the real API, the online filter applies to each page after it is read,
      // so a page can be short or empty while next_cursor is set.
      const { online, ...rest } = filter.value
      const page = devicePage(
        db
          .devices()
          .filter((d) => !visible || visible.has(d.id))
          .map((d) => (visible ? db.deviceViewForUser(d, actor.id) : d))
          .filter((d) => matches(d, rest, env)),
        url.searchParams,
        env,
        actor.id,
      )
      if (!page.ok) return respond.failure(page)
      const items =
        online === undefined
          ? page.value.items
          : page.value.items.filter((d) => d.online === online)
      return respond(200, { items, next_cursor: page.value.next_cursor })
    }),

    route(env, 'mfa', 'get', byId, ({ params, respond, actor }) => {
      const id = params.id ?? ''
      if (actor.role === 'user') {
        const device = db.visibleDeviceIds(actor.id).has(id) ? db.device(id) : undefined
        return device
          ? respond(200, db.deviceViewForUser(device, actor.id))
          : respond.error(404, 'not_found', 'not found')
      }
      const device = db.device(id)
      return device ? respond(200, device) : respond.error(404, 'not_found', 'device not found')
    }),

    route(env, 'staff', 'delete', byId, ({ params, respond, actor }) => {
      const r = db.deleteDevice(params.id ?? '', actor)
      return r.ok ? respond.empty(204) : respond.failure(r)
    }),

    route(env, 'staff', 'patch', byId, async ({ request, params, respond, actor }) => {
      const body = await readBody<Body<typeof byId, 'patch'>>(request, {
        alias: str({ max: 128 }),
        note: str({ max: 4096 }),
        group_id: str({ format: 'uuid', nullable: true }),
        tag_ids: arr(str({ format: 'uuid' })),
      })
      if (!body.ok) return respond.failure(body)
      const r = db.patchDevice(params.id ?? '', body.value, actor)
      return r.ok ? respond(200, r.value) : respond.failure(r)
    }),

    transition(`${V1}/devices/{id}/approve`, 'approve'),
    transition(`${V1}/devices/{id}/reject`, 'reject'),
    transition(`${V1}/devices/{id}/archive`, 'archive'),
    transition(`${V1}/devices/{id}/restore`, 'restore'),
    transition(`${V1}/devices/{id}/reopen`, 'reopen'),

    route(
      env,
      'staff',
      'post',
      `${V1}/devices/{id}/alerts/{alert_id}/resolve`,
      async ({ request, params, respond, actor }) => {
        const body = await readBody<
          Body<`${typeof V1}/devices/{id}/alerts/{alert_id}/resolve`, 'post'>
        >(request, {
          action: req(str({ values: ['accept_new_uuid', 'dismiss'] })),
        })
        if (!body.ok) return respond.failure(body)
        const r = db.resolveAlert(params.id ?? '', params.alert_id ?? '', body.value.action, actor)
        return r.ok ? respond(200, r.value) : respond.failure(r)
      },
    ),

    route(env, 'mfa', 'get', `${V1}/devices/{id}/connect`, ({ url, params, respond, actor }) => {
      const action = url.searchParams.get('action') ?? 'connect'
      const relay = url.searchParams.get('relay') ?? '0'
      const found = ACTIONS.find((a) => a === action)
      if (!found) return respond.error(400, 'bad_request', 'unknown action')
      if (relay !== '0' && relay !== '1')
        return respond.error(400, 'bad_request', 'relay must be 0 or 1')
      const device = db.device(params.id ?? '')
      const notFound = actor.role === 'user' ? 'not found' : 'device not found'
      if (
        !device ||
        device.state !== 'approved' ||
        !db.server ||
        (actor.role === 'user' && !db.visibleDeviceIds(actor.id).has(device.id))
      ) {
        return respond.error(404, 'not_found', notFound)
      }
      const policy = db.devicePolicyStatus(device.id)
      if (!policy.ok) return respond.failure(policy)
      if (policy.value.connect === 'locked')
        return respond.error(409, 'access_locked', 'Locked by policy. Allow access first.')
      const link = connectLink(db.server, device, found, relay === '1')
      db.record(actor, 'device.connect_link', 'device', device.id, {
        action: found,
        relay: relay === '1',
      })
      return respond(200, link)
    }),
  ]
}
