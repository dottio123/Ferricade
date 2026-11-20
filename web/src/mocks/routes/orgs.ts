// Groups and tags.
import type { HttpHandler } from 'msw'
import { route, type Body, type Env } from '../route'
import { int, paginate, readBody, str, req } from '../validate'

const V1 = '/admin/api/v1'
const COLOR = { min: 0, max: 4294967295 }

export function groupRoutes(env: Env): HttpHandler[] {
  const { db } = env
  const byId = `${V1}/groups/{id}` as const

  return [
    route(env, 'mfa', 'get', `${V1}/groups`, ({ respond, actor }) =>
      respond(200, {
        items: db.groupTree(actor.role === 'user' ? db.visibleGroupIds(actor.id) : undefined),
        next_cursor: '',
      }),
    ),

    route(env, 'staff', 'post', `${V1}/groups`, async ({ request, respond, actor }) => {
      const body = await readBody<Body<`${typeof V1}/groups`, 'post'>>(request, {
        name: req(str({ min: 1, max: 128 })),
        parent_id: str({ format: 'uuid', nullable: true }),
      })
      if (!body.ok) return respond.failure(body)
      const r = db.createGroup(body.value.name, body.value.parent_id ?? null, actor)
      return r.ok ? respond(201, r.value) : respond.failure(r)
    }),

    route(env, 'staff', 'patch', byId, async ({ request, params, respond, actor }) => {
      const body = await readBody<Body<typeof byId, 'patch'>>(request, {
        name: req(str({ min: 1, max: 128 })),
      })
      if (!body.ok) return respond.failure(body)
      const r = db.renameGroup(params.id ?? '', body.value.name, actor)
      return r.ok ? respond(200, r.value) : respond.failure(r)
    }),

    route(env, 'staff', 'delete', byId, ({ params, respond, actor }) => {
      const r = db.deleteGroup(params.id ?? '', actor)
      return r.ok ? respond.empty(204) : respond.failure(r)
    }),

    route(
      env,
      'staff',
      'post',
      `${V1}/groups/{id}/move`,
      async ({ request, params, respond, actor }) => {
        const body = await readBody<Body<`${typeof V1}/groups/{id}/move`, 'post'>>(request, {
          parent_id: req(str({ format: 'uuid', nullable: true })),
        })
        if (!body.ok) return respond.failure(body)
        const r = db.moveGroup(params.id ?? '', body.value.parent_id, actor)
        return r.ok ? respond(200, r.value) : respond.failure(r)
      },
    ),
  ]
}

export function tagRoutes(env: Env): HttpHandler[] {
  const { db } = env
  const byId = `${V1}/tags/{id}` as const

  return [
    route(env, 'mfa', 'get', `${V1}/tags`, ({ url, respond, actor }) => {
      const page = paginate(
        db.sortedTags(actor.role === 'user' ? db.visibleDeviceIds(actor.id) : undefined),
        url.searchParams,
      )
      return page.ok ? respond(200, page.value) : respond.failure(page)
    }),

    route(env, 'staff', 'post', `${V1}/tags`, async ({ request, respond, actor }) => {
      const body = await readBody<Body<`${typeof V1}/tags`, 'post'>>(request, {
        name: req(str({ min: 1, max: 64 })),
        color: int(COLOR),
      })
      if (!body.ok) return respond.failure(body)
      const r = db.createTag(body.value.name, body.value.color ?? 0, actor)
      return r.ok ? respond(201, r.value) : respond.failure(r)
    }),

    route(env, 'staff', 'patch', byId, async ({ request, params, respond, actor }) => {
      const body = await readBody<Body<typeof byId, 'patch'>>(request, {
        name: str({ min: 1, max: 64 }),
        color: int(COLOR),
      })
      if (!body.ok) return respond.failure(body)
      const r = db.updateTag(params.id ?? '', body.value, actor)
      return r.ok ? respond(200, r.value) : respond.failure(r)
    }),

    route(env, 'staff', 'delete', byId, ({ params, respond, actor }) => {
      const r = db.deleteTag(params.id ?? '', actor)
      return r.ok ? respond.empty(204) : respond.failure(r)
    }),
  ]
}
