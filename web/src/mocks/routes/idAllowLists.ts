import type { HttpHandler } from 'msw'
import { route, type Body, type Env } from '../route'
import { arr, readBody, str, req } from '../validate'

const V1 = '/admin/api/v1'
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]{5,15}$/

function validated(ids: string[]): string | null {
  if (ids.length > 200) return 'at most 200 IDs are allowed'
  if (ids.some((id) => !ID_PATTERN.test(id))) return 'an ID does not match the RustDesk ID format'
  if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length)
    return 'duplicate IDs are not allowed'
  return null
}

export function idAllowListRoutes(env: Env): HttpHandler[] {
  const { db } = env
  const bodySpec = { ids: req(arr(str({ pattern: ID_PATTERN }), { max: 200, unique: true })) }

  return [
    route(env, 'staff', 'get', `${V1}/settings/id-allow-list`, ({ respond }) =>
      respond(200, { ids: db.globalIdAllowList }),
    ),
    route(
      env,
      'owner',
      'put',
      `${V1}/settings/id-allow-list`,
      async ({ request, respond, actor }) => {
        const body = await readBody<Body<`${typeof V1}/settings/id-allow-list`, 'put'>>(
          request,
          bodySpec,
        )
        if (!body.ok) return respond.error(400, 'validation_error', body.message)
        const error = validated(body.value.ids)
        if (error) return respond.error(400, 'validation_error', error)
        return respond(200, { ids: db.setIDAllowList('global', 'global', body.value.ids, actor) })
      },
    ),
    route(env, 'staff', 'get', `${V1}/groups/{id}/id-allow-list`, ({ params, respond }) => {
      const id = params.id ?? ''
      if (!db.groups.some((group) => group.id === id))
        return respond.error(404, 'not_found', 'group not found')
      return respond(200, { ids: db.groupIdAllowLists.get(id) ?? [] })
    }),
    route(
      env,
      'staff',
      'put',
      `${V1}/groups/{id}/id-allow-list`,
      async ({ request, params, respond, actor }) => {
        const body = await readBody<Body<`${typeof V1}/groups/{id}/id-allow-list`, 'put'>>(
          request,
          bodySpec,
        )
        const id = params.id ?? ''
        if (!body.ok) return respond.error(400, 'validation_error', body.message)
        const error = validated(body.value.ids)
        if (error) return respond.error(400, 'validation_error', error)
        if (!db.groups.some((group) => group.id === id))
          return respond.error(404, 'not_found', 'group not found')
        return respond(200, { ids: db.setIDAllowList('group', id, body.value.ids, actor) })
      },
    ),
    route(env, 'staff', 'get', `${V1}/devices/{id}/id-allow-list`, ({ params, respond }) => {
      const result = db.idAllowListForDevice(params.id ?? '')
      return result ? respond(200, result) : respond.error(404, 'not_found', 'device not found')
    }),
    route(
      env,
      'staff',
      'put',
      `${V1}/devices/{id}/id-allow-list`,
      async ({ request, params, respond, actor }) => {
        const body = await readBody<Body<`${typeof V1}/devices/{id}/id-allow-list`, 'put'>>(
          request,
          bodySpec,
        )
        const id = params.id ?? ''
        if (!body.ok) return respond.error(400, 'validation_error', body.message)
        const error = validated(body.value.ids)
        if (error) return respond.error(400, 'validation_error', error)
        if (!db.deviceRows.some((device) => device.id === id))
          return respond.error(404, 'not_found', 'device not found')
        db.setIDAllowList('device', id, body.value.ids, actor)
        return respond(200, db.idAllowListForDevice(id)!)
      },
    ),
  ]
}
