// Audit log, sessions, statistics and the dashboard summary.
import type { HttpHandler } from 'msw'
import { fleetMap, history, isHistoryRange, isTimeZone, sessionStats, summary } from '../stats'
import { route, type Env } from '../route'
import { badRequest, isUuid, paginate, type Result } from '../validate'

const V1 = '/admin/api/v1'

/** since (inclusive) and until (exclusive) as milliseconds. */
function timeRange(query: URLSearchParams): Result<{ since: number; until: number }> {
  const read = (key: string, fallback: number): Result<number> => {
    const v = query.get(key)
    if (v === null) return { ok: true, value: fallback }
    const ms = Date.parse(v)
    return Number.isNaN(ms)
      ? badRequest(`${key} must be an RFC 3339 time`)
      : { ok: true, value: ms }
  }
  const since = read('since', -Infinity)
  if (!since.ok) return since
  const until = read('until', Infinity)
  if (!until.ok) return until
  return { ok: true, value: { since: since.value, until: until.value } }
}

function boolParam(query: URLSearchParams, key: string): Result<boolean | undefined> {
  const v = query.get(key)
  if (v === null) return { ok: true, value: undefined }
  if (v !== 'true' && v !== 'false') return badRequest(`${key} must be true or false`)
  return { ok: true, value: v === 'true' }
}

export function reportRoutes(env: Env): HttpHandler[] {
  const { db } = env

  return [
    route(env, 'mfa', 'get', `${V1}/audit`, ({ url, respond, actor: caller }) => {
      const q = url.searchParams
      // A User sees only their own entries; the actor parameter is ignored (but still validated).
      const actor = caller.role === 'user' ? caller.id : q.get('actor')
      if (caller.role !== 'user' && actor !== null && !isUuid(actor))
        return respond.error(400, 'bad_request', 'actor must be a UUID')
      const range = timeRange(q)
      if (!range.ok) return respond.failure(range)
      const action = q.get('action')
      const target = q.get('target')
      const items = db.auditLog.filter((e) => {
        const at = Date.parse(e.at)
        return (
          (action === null || e.action === action) &&
          // A User reads only their sign-in history and connect links (audit.go).
          (caller.role !== 'user' ||
            e.action.startsWith('auth.') ||
            e.action === 'device.connect_link') &&
          (actor === null || e.actor_user_id === actor) &&
          (target === null || e.target_id === target) &&
          at >= range.value.since &&
          at < range.value.until
        )
      })
      const page = paginate(items, q)
      return page.ok ? respond(200, page.value) : respond.failure(page)
    }),

    route(env, 'mfa', 'get', `${V1}/sessions`, ({ url, respond, actor }) => {
      const visible = actor.role === 'user' ? db.visibleDeviceIds(actor.id) : null
      const q = url.searchParams
      const deviceId = q.get('device_id')
      if (deviceId !== null && !isUuid(deviceId))
        return respond.error(400, 'bad_request', 'device_id must be a UUID')
      const active = boolParam(q, 'active')
      if (!active.ok) return respond.failure(active)
      const authenticated = boolParam(q, 'authenticated')
      if (!authenticated.ok) return respond.failure(authenticated)
      const range = timeRange(q)
      if (!range.ok) return respond.failure(range)
      const rows = db.sessionRows.filter((s) => {
        const at = Date.parse(s.started_at)
        return (
          (!visible || visible.has(s.device_id)) &&
          (deviceId === null || s.device_id === deviceId) &&
          (active.value === undefined || (s.ended_at === null) === active.value) &&
          (authenticated.value === undefined || (s.authed_at !== null) === authenticated.value) &&
          at >= range.value.since &&
          at < range.value.until
        )
      })
      const page = paginate(rows, q)
      if (!page.ok) return respond.failure(page)
      return respond(200, {
        items: page.value.items.map((s) => {
          const view = db.sessionView(s)
          // Other people's addresses stay hidden from a User.
          return actor.role === 'user' ? { ...view, client_ip: null } : view
        }),
        next_cursor: page.value.next_cursor,
      })
    }),

    route(env, 'staff', 'post', `${V1}/sessions/{id}/disconnect`, ({ params, respond, actor }) => {
      const r = db.requestDisconnect(params.id ?? '', actor)
      return r.ok ? respond(202, r.value) : respond.failure(r)
    }),

    route(env, 'mfa', 'get', `${V1}/sessions/stats`, ({ url, respond, actor }) => {
      const range = url.searchParams.get('range') ?? '7d'
      const tz = url.searchParams.get('tz') ?? 'UTC'
      if (range !== '7d' && range !== '30d')
        return respond.error(400, 'bad_request', 'range must be 7d or 30d')
      if (!isTimeZone(tz))
        return respond.error(400, 'bad_request', 'tz is not a known IANA time zone')
      return respond(
        200,
        sessionStats(
          db,
          range,
          tz,
          actor.role === 'user' ? db.visibleDeviceIds(actor.id) : undefined,
        ),
      )
    }),

    route(env, 'staff', 'get', `${V1}/stats/history`, ({ url, respond }) => {
      const range = url.searchParams.get('range')
      if (!isHistoryRange(range))
        return respond.error(400, 'bad_request', 'range must be 24h, 7d or 30d')
      return respond(200, history(db, range))
    }),

    route(env, 'mfa', 'get', `${V1}/stats/summary`, ({ respond, actor }) =>
      respond(
        200,
        summary(
          db,
          actor.role === 'user'
            ? { devices: db.visibleDeviceIds(actor.id), groups: db.visibleGroupIds(actor.id) }
            : undefined,
        ),
      ),
    ),

    route(env, 'mfa', 'get', `${V1}/stats/fleet-map`, ({ respond, actor }) =>
      respond(
        200,
        fleetMap(
          db,
          actor.role === 'user'
            ? { devices: db.visibleDeviceIds(actor.id), groups: db.visibleGroupIds(actor.id) }
            : undefined,
        ),
      ),
    ),
  ]
}
