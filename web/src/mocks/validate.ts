// Request validation for the mock handlers. The server rejects unknown fields,
// wrong types and out-of-range values with 400 "bad_request"; so does the mock.
// A body is described by a Spec<T> built from the contract's request type T:
// the compiler checks the spec names every field of T, no more, and which are
// required, so a spec cannot drift from the contract's field list.
import type { Error as ErrorBody } from './fixtures/types'

export type ErrorCode = ErrorBody['error']['code']

export interface Failure {
  status: 400 | 401 | 403 | 404 | 409 | 423 | 429
  code: ErrorCode
  message: string
}
export type Result<T> = { ok: true; value: T } | ({ ok: false } & Failure)

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = (
  status: Failure['status'],
  code: ErrorCode,
  message: string,
): Result<never> => ({
  ok: false,
  status,
  code,
  message,
})
export const badRequest = (message: string) => fail(400, 'bad_request', message)
export const notFound = (what = 'not found') => fail(404, 'not_found', what)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Format = 'uuid' | 'email'
interface Common {
  nullable?: boolean
}
/** A field a body may leave out. */
export type Optional = Rule & { required?: false }
/** A field a body must have; made with req(). */
export type Required = Rule & { required: true }
export type Rule = Common & { required?: boolean } & (
    | {
        kind: 'string'
        min?: number
        max?: number
        values?: readonly string[]
        pattern?: RegExp
        format?: Format
      }
    | { kind: 'integer'; min?: number; max?: number }
    | { kind: 'boolean' }
    | { kind: 'array'; items: Rule; max?: number; unique?: boolean }
    | { kind: 'object'; spec: Record<string, Rule> }
  )

type RuleFor<T, K extends keyof T> = undefined extends T[K] ? Optional : Required
export type Spec<T> = { [K in keyof T]-?: RuleFor<T, K> }

function check(rule: Rule, v: unknown, path: string): string | null {
  if (v === null) return rule.nullable ? null : `${path} must not be null`
  switch (rule.kind) {
    case 'string': {
      if (typeof v !== 'string') return `${path} must be a string`
      const len = [...v].length
      if (rule.min !== undefined && len < rule.min)
        return `${path} must have at least ${rule.min} characters`
      if (rule.max !== undefined && len > rule.max)
        return `${path} must have at most ${rule.max} characters`
      if (rule.values && !rule.values.includes(v))
        return `${path} must be one of ${rule.values.join(', ')}`
      if (rule.pattern && !rule.pattern.test(v)) return `${path} is malformed`
      if (rule.format === 'uuid' && !UUID.test(v)) return `${path} must be a UUID`
      if (rule.format === 'email' && !EMAIL.test(v)) return `${path} must be an email address`
      return null
    }
    case 'integer':
      if (typeof v !== 'number' || !Number.isInteger(v)) return `${path} must be an integer`
      if (rule.min !== undefined && v < rule.min) return `${path} must be at least ${rule.min}`
      if (rule.max !== undefined && v > rule.max) return `${path} must be at most ${rule.max}`
      return null
    case 'boolean':
      return typeof v === 'boolean' ? null : `${path} must be a boolean`
    case 'array': {
      if (!Array.isArray(v)) return `${path} must be an array`
      if (rule.max !== undefined && v.length > rule.max)
        return `${path} must have at most ${rule.max} items`
      for (const [i, item] of v.entries()) {
        const problem = check(rule.items, item, `${path}[${i}]`)
        if (problem) return problem
      }
      if (rule.unique && new Set(v.map((x: unknown) => JSON.stringify(x))).size !== v.length)
        return `${path} must not repeat items`
      return null
    }
    case 'object':
      return checkObject(rule.spec, v, path)
  }
}

function checkObject(spec: Record<string, Rule>, v: unknown, path: string): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return `${path} must be an object`
  const body = v as Record<string, unknown>
  for (const key of Object.keys(body)) {
    if (!(key in spec)) return `unknown field ${path ? path + '.' : ''}${key}`
  }
  for (const [key, rule] of Object.entries(spec)) {
    const name = path ? `${path}.${key}` : key
    if (!(key in body)) {
      if (rule.required) return `${name} is required`
      continue
    }
    const problem = check(rule, body[key], name)
    if (problem) return problem
  }
  return null
}

/** Reads and validates a JSON request body against the contract-derived spec. */
export async function readBody<T extends object>(
  request: Request,
  spec: Spec<T>,
): Promise<Result<T>> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return badRequest('the request body is not valid JSON')
  }
  const problem = checkObject(spec, parsed, '')
  // checkObject has verified every field against the spec derived from T.
  return problem ? badRequest(problem) : ok(parsed as T)
}

type Opts<K extends Rule['kind']> = Omit<Extract<Rule, { kind: K }>, 'kind' | 'required'>

// Rule builders. A field is optional unless wrapped in req().
export const str = (o: Opts<'string'> = {}): Optional => ({ kind: 'string', ...o })
export const int = (o: Opts<'integer'> = {}): Optional => ({ kind: 'integer', ...o })
export const bool = (o: Common = {}): Optional => ({ kind: 'boolean', ...o })
export const arr = (items: Rule, o: Omit<Opts<'array'>, 'items'> = {}): Optional => ({
  kind: 'array',
  items,
  ...o,
})
export const obj = (spec: Record<string, Rule>, o: Common = {}): Optional => ({
  kind: 'object',
  spec,
  ...o,
})
export const req = (rule: Rule): Required => ({ ...rule, required: true })

/** Page of a list: limit defaults to 50, at most 200; the cursor is the offset of the next page. */
export function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
): Result<{ items: T[]; next_cursor: string }> {
  const limitText = query.get('limit')
  let limit = 50
  if (limitText !== null) {
    if (!/^\d+$/.test(limitText) || Number(limitText) < 1)
      return badRequest('limit must be a positive integer')
    limit = Math.min(Number(limitText), 200)
  }
  const cursorText = query.get('cursor') ?? ''
  if (cursorText !== '' && !/^\d+$/.test(cursorText)) return badRequest('cursor is not valid')
  const start = Number(cursorText || '0')
  const end = start + limit
  return ok({ items: items.slice(start, end), next_cursor: end < items.length ? String(end) : '' })
}
