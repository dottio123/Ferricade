import type { HttpHandler } from 'msw'
import { route, type Body, type Env } from '../route'
import { readBody, req, str } from '../validate'

const V1 = '/admin/api/v1'
export function groupRuleRoutes(env: Env): HttpHandler[] {
  const { db } = env
  return [
    route(env, 'owner', 'post', `${V1}/devices/auto-sort/preview`, ({ respond }) =>
      respond(200, db.autoSortPreview()),
    ),
    route(env, 'owner', 'post', `${V1}/devices/auto-sort`, ({ respond, actor }) =>
      respond(200, db.autoSort(actor)),
    ),
    route(env, 'staff', 'get', `${V1}/group-rules`, ({ respond }) =>
      respond(200, { items: db.sortedGroupRules(), next_cursor: '' }),
    ),
    route(
      env,
      'staff',
      'post',
      `${V1}/groups/{id}/rules`,
      async ({ request, params, respond, actor }) => {
        const body = await readBody<Body<`${typeof V1}/groups/{id}/rules`, 'post'>>(request, {
          pattern: req(str({ min: 1, max: 128 })),
        })
        if (!body.ok) return respond.failure(body)
        const result = db.addGroupRule(params.id ?? '', body.value.pattern, actor)
        return result.ok ? respond(201, result.value) : respond.failure(result)
      },
    ),
    route(
      env,
      'staff',
      'delete',
      `${V1}/groups/{id}/rules/{rule_id}`,
      ({ params, respond, actor }) => {
        const result = db.removeGroupRule(params.id ?? '', params.rule_id ?? '', actor)
        return result.ok ? respond.empty(204) : respond.failure(result)
      },
    ),
    route(
      env,
      'staff',
      'post',
      `${V1}/groups/{id}/rules/preview`,
      async ({ request, params, respond }) => {
        const body = await readBody<Body<`${typeof V1}/groups/{id}/rules/preview`, 'post'>>(
          request,
          { pattern: req(str({ min: 1, max: 128 })) },
        )
        if (!body.ok) return respond.failure(body)
        const result = db.previewGroupRule(params.id ?? '', body.value.pattern)
        return result.ok ? respond(200, result.value) : respond.failure(result)
      },
    ),
  ]
}
