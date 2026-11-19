// Test support: reads internal/adminapi/openapi.yaml and validates JSON against
// the response schemas it declares, so a mock that drifts from the contract
// fails `npm test`. Not imported by the app or the mock worker.
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parse } from 'yaml'
import specText from '../../../internal/adminapi/openapi.yaml?raw'

type Json = Record<string, unknown>
const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const

const spec = parse(specText) as { paths: Record<string, Json>; components: Json }

function asObject(v: unknown, what: string): Json {
  if (typeof v !== 'object' || v === null) throw new Error(`openapi.yaml: ${what} is not an object`)
  return v as Json
}

/** Every operation of the contract as "METHOD /path/{param}". */
export function contractOperations(): string[] {
  const ops: string[] = []
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const m of METHODS) if (m in item) ops.push(`${m.toUpperCase()} ${path}`)
  }
  return ops
}

/** The response object (with $ref resolved) for a status, or undefined when undocumented. */
function responseFor(method: string, path: string, status: number): Json | undefined {
  const item = asObject(spec.paths[path], path)
  const op = asObject(item[method.toLowerCase()], `${method} ${path}`)
  const responses = asObject(op.responses, `${method} ${path} responses`)
  let response = responses[String(status)] as Json | undefined
  if (response === undefined) return undefined
  if (typeof response.$ref === 'string') {
    const name = response.$ref.split('/').pop() ?? ''
    response = asObject(asObject(spec.components.responses, 'components.responses')[name], name)
  }
  return response
}

export function documentedStatuses(method: string, path: string): number[] {
  const item = asObject(spec.paths[path], path)
  const op = asObject(item[method.toLowerCase()], `${method} ${path}`)
  return Object.keys(asObject(op.responses, 'responses')).map(Number)
}

const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats(ajv)
ajv.addFormat('int64', true)
const compiled = new Map<string, ReturnType<Ajv2020['compile']>>()

function validatorFor(schema: Json, key: string) {
  let v = compiled.get(key)
  if (!v) {
    // $refs are "#/components/schemas/X", so the schema carries the components.
    v = ajv.compile({ ...schema, components: spec.components })
    compiled.set(key, v)
  }
  return v
}

/** Validates a LiveEvent data payload; returns the problems (empty when valid). */
export function liveEventProblems(payload: unknown): string[] {
  const schemas = asObject(spec.components.schemas, 'schemas')
  const v = validatorFor(asObject(schemas.LiveEvent, 'LiveEvent'), 'LiveEvent')
  return v(payload) ? [] : (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`)
}

/**
 * Checks a response against the contract: the status must be documented, a
 * JSON body must satisfy the documented schema, and a status without content
 * (204) must have no body. Returns the problems (empty when it conforms).
 */
export function responseProblems(
  method: string,
  path: string,
  status: number,
  body: unknown,
): string[] {
  const response = responseFor(method, path, status)
  if (!response) return [`status ${status} is not documented for ${method} ${path}`]
  const content = response.content as Json | undefined
  const json = content?.['application/json'] as Json | undefined
  if (!json) return body === undefined ? [] : [`${status} documents no body but one was sent`]
  if (body === undefined) return [`${status} documents a JSON body but none was sent`]
  const v = validatorFor(asObject(json.schema, 'schema'), `${method} ${path} ${status}`)
  return v(body) ? [] : (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`)
}
