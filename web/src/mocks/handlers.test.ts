import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import { contractOperations, liveEventProblems, responseProblems } from './contract'
import { readMockConfig, type MockConfig } from './config'
import { createMockControls } from './controls'
import { createMockDB, type MockDB } from './db'
import { createMockApi, handlers } from './handlers'
import { createMockServer } from './node'
import { OPERATIONS } from './operations'
import { setupServer } from 'msw/node'
import type { Env } from './route'

type Schemas = components['schemas']
const V1 = '/admin/api/v1'
const PASSWORD = 'correct horse battery'
const SOME_UUID = '2b1f4a0e-6c41-4a39-9d7f-0a56a6f9a111'

interface Result {
  status: number
  body: unknown
}
interface CallOpts {
  body?: unknown
  csrf?: string | null
  setupToken?: string
  accept?: string
  redirect?: RequestRedirect
}

// A fetch that resolves relative URLs against jsdom's page, as a browser does.
async function raw(method: string, path: string, opts: CallOpts = {}): Promise<Response> {
  const headers = new Headers()
  if (opts.csrf) headers.set('X-CSRF-Token', opts.csrf)
  if (opts.accept) headers.set('Accept', opts.accept)
  if (opts.setupToken) headers.set('X-Setup-Token', opts.setupToken)
  let body: string | undefined
  if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(opts.body)
  }
  return fetch(new Request(path, { method, headers, body, redirect: opts.redirect }))
}

async function send(method: string, path: string, opts: CallOpts = {}): Promise<Result> {
  const res = await raw(method, path, opts)
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : undefined }
}

type Server = ReturnType<typeof setupServer>
function use(db: MockDB, config: MockConfig): Server {
  const server = createMockServer(db, config)
  server.listen({ onUnhandledRequest: 'error' })
  return server
}

describe('every operation of openapi.yaml', () => {
  it('has an operation id for every contract operation', () => {
    const operations = OPERATIONS.map(
      (operation) => `${operation.method.toUpperCase()} ${operation.path}`,
    )
    expect(operations.toSorted()).toEqual(contractOperations().toSorted())
  })

  it('is served by a handler (the event stream by a gate and a stream handler)', () => {
    const db = createMockDB('small')
    const mocked = handlers(db, readMockConfig('')).map((h) => {
      const info = h.info as { method: string; path: string }
      return `${info.method} ${info.path.replace(/:(\w+)/g, '{$1}')}`
    })
    expect([...new Set(mocked)].toSorted()).toEqual(contractOperations().toSorted())
  })
})

describe('session settings mock', () => {
  const path = `${V1}/settings/sessions`

  it('returns the browser default before any change', async () => {
    const server = use(createMockDB('small'), readMockConfig(''))
    try {
      const result = await send('GET', path)
      expect(result).toEqual({
        status: 200,
        body: { lifetime: 'browser', updated_at: null, updated_by: null },
      })
      expect(responseProblems('GET', path, result.status, result.body)).toEqual([])
    } finally {
      server.close()
    }
  })

  it('saves every allowed duration and audits only changes with their actor and time', async () => {
    let now = Date.parse('2026-10-23T12:00:00Z')
    const db = createMockDB('small', { clock: () => now })
    const owner = db.users.find((user) => user.role === 'owner')!
    const server = use(db, readMockConfig(''))
    const entries = () => db.auditLog.filter((entry) => entry.action === 'session_lifetime.changed')
    try {
      const csrf = ((await send('GET', `${V1}/auth/me`)).body as Schemas['CSRFToken']).csrf_token
      expect(await send('PUT', path, { csrf, body: { lifetime: 'browser' } })).toEqual({
        status: 200,
        body: { lifetime: 'browser', updated_at: null, updated_by: null },
      })
      expect(entries()).toHaveLength(0)
      let before = 'browser'
      for (const lifetime of ['8h', '1d', '7d', '30d', 'browser']) {
        now += 1000
        const saved = await send('PUT', path, { csrf, body: { lifetime } })
        expect(saved).toEqual({
          status: 200,
          body: {
            lifetime,
            updated_at: new Date(now).toISOString(),
            updated_by: { id: owner.id, display_name: owner.display_name },
          },
        })
        expect(responseProblems('PUT', path, saved.status, saved.body)).toEqual([])
        expect(await send('GET', path)).toEqual(saved)
        expect(entries()[0]).toMatchObject({
          actor_user_id: owner.id,
          at: new Date(now).toISOString(),
          target_type: 'settings',
          target_id: 'sessions',
          details: { before, after: lifetime },
        })
        const count = entries().length
        now += 1000
        expect(await send('PUT', path, { csrf, body: { lifetime } })).toEqual(saved)
        expect(entries()).toHaveLength(count)
        before = lifetime
      }
      expect(entries()).toHaveLength(5)
    } finally {
      server.close()
    }
  })

  it.each([
    { label: 'unknown lifetime', body: { lifetime: 'forever' } },
    { label: 'extra field', body: { lifetime: '7d', extra: true } },
    { label: 'missing lifetime', body: {} },
    { label: 'null lifetime', body: { lifetime: null } },
    { label: 'wrong type', body: { lifetime: 7 } },
    { label: 'null body', body: null },
    { label: 'array body', body: [] },
  ])('rejects $label without changing state or audit', async ({ body }) => {
    const db = createMockDB('small')
    const server = use(db, readMockConfig(''))
    try {
      const csrf = ((await send('GET', `${V1}/auth/me`)).body as Schemas['CSRFToken']).csrf_token
      const result = await send('PUT', path, { csrf, body })
      expect(result).toMatchObject({ status: 400, body: { error: { code: 'bad_request' } } })
      expect(responseProblems('PUT', path, result.status, result.body)).toEqual([])
      expect((await send('GET', path)).body).toEqual({
        lifetime: 'browser',
        updated_at: null,
        updated_by: null,
      })
      expect(db.auditLog.some((entry) => entry.action === 'session_lifetime.changed')).toBe(false)
    } finally {
      server.close()
    }
  })

  it.each(['admin', 'user'] as const)('enforces %s permissions', async (role) => {
    const db = createMockDB('small')
    const server = use(db, readMockConfig(`?mock-role=${role}`))
    try {
      const csrf = ((await send('GET', `${V1}/auth/me`)).body as Schemas['CSRFToken']).csrf_token
      const read = await send('GET', path)
      expect(read.status).toBe(role === 'admin' ? 200 : 403)
      if (role === 'user') expect(read.body).toMatchObject({ error: { code: 'forbidden' } })
      expect(responseProblems('GET', path, read.status, read.body)).toEqual([])
      const write = await send('PUT', path, { csrf, body: { lifetime: '7d' } })
      expect(write).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
      expect(responseProblems('PUT', path, write.status, write.body)).toEqual([])
      expect(db.auditLog.some((entry) => entry.action === 'session_lifetime.changed')).toBe(false)
    } finally {
      server.close()
    }
  })

  it('requires a session and CSRF for writes', async () => {
    const db = createMockDB('small')
    const api = createMockApi(db, readMockConfig(''))
    const server = setupServer(...api.handlers)
    server.listen({ onUnhandledRequest: 'error' })
    try {
      expect(await send('PUT', path, { body: { lifetime: '7d' } })).toMatchObject({
        status: 403,
        body: { error: { code: 'csrf' } },
      })
      api.env.session.userId = null
      for (const method of ['GET', 'PUT']) {
        expect(
          await send(method, path, { body: method === 'PUT' ? { lifetime: '7d' } : undefined }),
        ).toMatchObject({ status: 401, body: { error: { code: 'unauthenticated' } } })
      }
      expect(db.auditLog.some((entry) => entry.action === 'session_lifetime.changed')).toBe(false)
    } finally {
      server.close()
    }
  })
})

describe('ID allow-list mock', () => {
  it('stores global, group, and device lists and returns effective sources', async () => {
    const db = createMockDB('small')
    const group = db.groups.find((item) => item.name === 'Office')!
    const child = {
      ...group,
      id: '00000000-0000-4000-8000-000000000001',
      parent_id: group.id,
      name: 'Child',
    }
    db.groups.push(child)
    const device = db.deviceRows.find(
      (item) => item.state === 'approved' && item.group_id === group.id,
    )!
    device.group_id = child.id
    db.globalIdAllowList = ['Global_1', 'shared_1']
    db.groupIdAllowLists.set(group.id, ['Group__1', 'shared_1'])
    db.groupIdAllowLists.set(child.id, ['Child_1', 'shared_1'])
    db.deviceIdAllowLists.set(device.id, ['Device_1', 'shared_1'])
    const server = use(db, readMockConfig(''))
    try {
      const csrf = ((await send('GET', `${V1}/auth/me`)).body as Schemas['CSRFToken']).csrf_token
      expect(
        await send('PUT', `${V1}/settings/id-allow-list`, {
          csrf,
          body: { ids: ['Global_1', 'shared_1'] },
        }),
      ).toMatchObject({ status: 200, body: { ids: ['Global_1', 'shared_1'] } })
      expect(
        await send('PUT', `${V1}/groups/${group.id}/id-allow-list`, {
          csrf,
          body: { ids: ['Group__1', 'shared_1'] },
        }),
      ).toMatchObject({ status: 200, body: { ids: ['Group__1', 'shared_1'] } })
      expect(
        await send('PUT', `${V1}/groups/${child.id}/id-allow-list`, {
          csrf,
          body: { ids: ['Child_1', 'shared_1'] },
        }),
      ).toMatchObject({ status: 200, body: { ids: ['Child_1', 'shared_1'] } })
      expect(
        await send('PUT', `${V1}/devices/${device.id}/id-allow-list`, {
          csrf,
          body: { ids: ['Device_1', 'shared_1'] },
        }),
      ).toMatchObject({ status: 200 })
      const result = await send('GET', `${V1}/devices/${device.id}/id-allow-list`)
      expect(result).toMatchObject({
        status: 200,
        body: {
          ids: ['Device_1', 'shared_1'],
          effective: [
            { id: 'Child_1', source: 'group', group_id: child.id, group_name: 'Child' },
            { id: 'Device_1', source: 'device', group_id: null, group_name: null },
            { id: 'Global_1', source: 'global', group_id: null, group_name: null },
            { id: 'Group__1', source: 'group', group_id: group.id, group_name: 'Office' },
            { id: 'shared_1', source: 'device', group_id: null, group_name: null },
            { id: 'shared_1', source: 'global', group_id: null, group_name: null },
            { id: 'shared_1', source: 'group', group_id: child.id, group_name: 'Child' },
          ],
        },
      })
      expect(
        responseProblems('GET', `${V1}/devices/{id}/id-allow-list`, result.status, result.body),
      ).toEqual([])
      const invalid = await send('PUT', `${V1}/settings/id-allow-list`, {
        csrf,
        body: { ids: ['Global_1', 'global_1'] },
      })
      expect(invalid).toMatchObject({ status: 400, body: { error: { code: 'validation_error' } } })
    } finally {
      server.close()
    }
  })
})

describe('auto sort mock', () => {
  it('serves both owner operations with CSRF and denies admin and User', async () => {
    for (const role of ['owner', 'admin', 'user'] as const) {
      const server = use(createMockDB('small'), readMockConfig(`?mock-role=${role}`))
      try {
        const csrf = ((await send('GET', `${V1}/auth/me`)).body as Schemas['CSRFToken']).csrf_token
        for (const path of [`${V1}/devices/auto-sort/preview`, `${V1}/devices/auto-sort`]) {
          const result = await send('POST', path, { csrf })
          expect(result.status).toBe(role === 'owner' ? 200 : 403)
          expect(responseProblems('POST', path, result.status, result.body)).toEqual([])
          expect((await send('POST', path)).status).toBe(403)
        }
      } finally {
        server.close()
      }
    }
  })
})

describe('device sorting mock', () => {
  it.each([
    ['name', 'desc', [0, 4, 3, 2, 6, 1, 5]],
    ['group', 'asc', [1, 2, 4, 0, 6, 3, 5]],
  ] as const)('pages %s %s with ties and missing values', async (sort, order, expected) => {
    const db = createMockDB('small')
    const base = db.deviceRows[0]!
    const a = db.groups[0]!
    const b = db.groups[1]!
    a.name = 'Alpha'
    b.name = 'beta'
    const data = [
      ['107', 'Zulu', 'ignored', b.id],
      ['102', 'apple', 'ignored', a.id],
      ['103', '', 'APPLE', a.id],
      ['104', '', 'Yak', null],
      ['105', 'zeta', 'ignored', b.id],
      ['106', '', '', null],
      ['102', 'Apple', 'ignored', null],
    ] as const
    db.deviceRows = data.map(([rustdesk_id, alias, hostname, group_id], i) => ({
      ...base,
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      rustdesk_id,
      alias,
      hostname,
      group_id,
      state: 'approved',
      open_alerts: [],
    }))
    const server = use(db, readMockConfig('?mock-role=owner'))
    try {
      let cursor = ''
      const ids: string[] = []
      for (let page = 0; ; page++) {
        expect(page).toBeLessThan(10)
        const res = await send(
          'GET',
          `${V1}/devices?sort=${sort}&order=${order}&limit=2&cursor=${encodeURIComponent(cursor)}`,
        )
        expect(res.status).toBe(200)
        const body = res.body as { items: Schemas['Device'][]; next_cursor: string }
        ids.push(...body.items.map((d) => d.id))
        cursor = body.next_cursor
        if (!cursor) break
        if (page === 0) {
          for (const query of [
            `sort=${sort === 'name' ? 'os' : 'name'}&order=${order}`,
            `sort=${sort}&order=${order === 'asc' ? 'desc' : 'asc'}`,
            `sort=${sort}&order=${order}&state=approved`,
          ]) {
            const mismatch = await send(
              'GET',
              `${V1}/devices?${query}&cursor=${encodeURIComponent(cursor)}`,
            )
            expect(mismatch.status).toBe(400)
          }
        }
      }
      expect(ids).toEqual(expected.map((i) => db.deviceRows[i]!.id))
    } finally {
      server.close()
    }
  })

  it.each(['sort=unknown', 'order=up', 'sort=', 'order='])('rejects %s', async (query) => {
    const server = use(createMockDB('small'), readMockConfig('?mock-role=owner'))
    try {
      expect((await send('GET', `${V1}/devices?${query}`)).status).toBe(400)
    } finally {
      server.close()
    }
  })
})

describe('device subgroup filter mock', () => {
  it('includes descendants and rejects subgroup filtering without a group or with ungrouped', async () => {
    const db = createMockDB('small')
    const parent = db.groups[0]!
    const child = {
      ...parent,
      id: '00000000-0000-4000-8000-000000000098',
      name: 'Child',
      parent_id: parent.id,
    }
    const grandchild = {
      ...child,
      id: '00000000-0000-4000-8000-000000000099',
      name: 'Grandchild',
      parent_id: child.id,
    }
    db.groups.push(child, grandchild)
    const base = db.deviceRows[0]!
    db.deviceRows = [
      {
        ...base,
        id: '00000000-0000-4000-8000-000000000091',
        rustdesk_id: 'parent-device',
        group_id: parent.id,
      },
      {
        ...base,
        id: '00000000-0000-4000-8000-000000000092',
        rustdesk_id: 'child-device',
        group_id: child.id,
      },
      {
        ...base,
        id: '00000000-0000-4000-8000-000000000093',
        rustdesk_id: 'grandchild-device',
        group_id: grandchild.id,
      },
    ]
    const server = use(db, readMockConfig('?mock-role=owner'))
    try {
      const included = await send('GET', `${V1}/devices?group=${parent.id}&subgroups=true`)
      expect(included.status).toBe(200)
      expect(
        (included.body as { items: Schemas['Device'][] }).items.map((d) => d.rustdesk_id),
      ).toEqual(['child-device', 'grandchild-device', 'parent-device'])
      expect((await send('GET', `${V1}/devices?subgroups=true`)).status).toBe(400)
      expect(
        (await send('GET', `${V1}/devices?group=${parent.id}&subgroups=true&ungrouped=true`))
          .status,
      ).toBe(400)
    } finally {
      server.close()
    }
  })
})

describe('log export mock', () => {
  const path = `${V1}/settings/log-export`
  const settings: Schemas['LogExportSettings'] = {
    file: { enabled: true },
    syslog: {
      enabled: false,
      host: '',
      port: 6514,
      tls: true,
      ca_pem: '',
      facility: 'local0',
      format: 'json',
    },
  }

  it('keeps owner changes, validates input, and handles direct tests', async () => {
    const db = createMockDB('small')
    const server = use(db, readMockConfig(''))
    try {
      const csrf = ((await send('GET', `${V1}/auth/me`)).body as Schemas['CSRFToken']).csrf_token
      const initial = await send('GET', path)
      expect(initial.status).toBe(200)
      expect(responseProblems('GET', path, 200, initial.body)).toEqual([])
      const saved = await send('PUT', path, { csrf, body: settings })
      expect(saved.status).toBe(200)
      expect(responseProblems('PUT', path, 200, saved.body)).toEqual([])
      expect((saved.body as Schemas['LogExport']).settings.file.enabled).toBe(true)
      const auditCount = db.auditLog.filter(
        (entry) => entry.action === 'settings.log_export_updated',
      ).length
      expect(auditCount).toBe(1)
      expect((await send('PUT', path, { csrf, body: settings })).status).toBe(200)
      expect(
        db.auditLog.filter((entry) => entry.action === 'settings.log_export_updated'),
      ).toHaveLength(1)
      expect(
        (
          await send('PUT', path, {
            csrf,
            body: { ...settings, syslog: { ...settings.syslog, enabled: true } },
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await send('PUT', path, {
            csrf,
            body: {
              ...settings,
              syslog: {
                ...settings.syslog,
                ca_pem: '-----BEGIN CERTIFICATE-----\nZ2FyYmFnZQ==\n-----END CERTIFICATE-----',
              },
            },
          })
        ).status,
      ).toBe(400)
      const tooLongCA = await send('PUT', path, {
        csrf,
        body: { ...settings, syslog: { ...settings.syslog, ca_pem: 'x'.repeat(32769) } },
      })
      expect(tooLongCA.status).toBe(400)
      const test = await send('POST', `${path}/test`, { csrf, body: { output: 'file' } })
      expect(test).toEqual({ status: 200, body: { ok: true, error: null } })
      expect(await send('POST', `${path}/test`, { csrf, body: { output: 'syslog' } })).toEqual({
        status: 200,
        body: { ok: false, error: 'no syslog host set' },
      })
      expect(
        (
          await send('PUT', path, {
            csrf,
            body: { ...settings, syslog: { ...settings.syslog, host: 'collector.test' } },
          })
        ).status,
      ).toBe(200)
      expect(await send('POST', `${path}/test`, { csrf, body: { output: 'syslog' } })).toEqual({
        status: 200,
        body: { ok: true, error: null },
      })
      expect(
        db.auditLog.filter((entry) => entry.action === 'settings.log_export_updated'),
      ).toHaveLength(2)
    } finally {
      server.close()
    }
  })

  it('lets admins read and denies all operations to Users', async () => {
    for (const role of ['admin', 'user'] as const) {
      const server = use(createMockDB('small'), readMockConfig(`?mock-role=${role}`))
      try {
        const csrf = ((await send('GET', `${V1}/auth/me`)).body as Schemas['CSRFToken']).csrf_token
        expect((await send('GET', path)).status).toBe(role === 'admin' ? 200 : 403)
        expect((await send('PUT', path, { csrf, body: settings })).status).toBe(403)
        expect(
          (await send('POST', `${path}/test`, { csrf, body: { output: 'file' } })).status,
        ).toBe(403)
      } finally {
        server.close()
      }
    }
  })
})

describe('the contract check itself', () => {
  const device: Schemas['Device'] = {
    id: SOME_UUID,
    rustdesk_id: '123456789',
    uuid: 'u',
    state: 'approved',
    alias: '',
    hostname: 'h',
    os: 'Linux / Debian 12',
    cpu: '',
    memory: '',
    client_version: '1.4.0',
    username: '',
    note: '',
    group_id: null,
    first_seen_at: '2026-10-01T10:00:00Z',
    last_seen_at: '2026-10-01T10:00:00Z',
    approved_by: null,
    approved_at: null,
    updated_at: '2026-10-01T10:00:00Z',
    tags: [],
    open_alerts: [],
    online: true,
    conns: [],
  }
  const get = (body: unknown, status = 200) =>
    responseProblems('GET', `${V1}/devices/{id}`, status, body)

  it('accepts a conforming body', () => {
    expect(get(device)).toEqual([])
  })

  it('rejects a drifted fixture: an extra field, a missing field, a wrong type, a bad format, an unknown status', () => {
    expect(get({ ...device, invented: 1 })).not.toEqual([])
    const missing = Object.fromEntries(Object.entries(device).filter(([k]) => k !== 'hostname'))
    expect(get(missing)).not.toEqual([])
    expect(get({ ...device, online: 'yes' })).not.toEqual([])
    expect(get({ ...device, id: 'not-a-uuid' })).not.toEqual([])
    expect(get({ ...device, state: 'deleted' })).not.toEqual([])
    expect(get(device, 418)).not.toEqual([])
  })
})

describe('the medium mock against the contract', () => {
  let db: MockDB
  let server: Server
  let env: Env
  let csrf: string
  const covered = new Set<string>()
  const ids: Record<string, string> = {}

  it('auto sorts the approved fleet', async () => {
    for (const path of [`${V1}/devices/auto-sort/preview`, `${V1}/devices/auto-sort`]) {
      await check('POST', path, path, 200)
    }
  })

  beforeAll(async () => {
    db = createMockDB('medium')
    const api = createMockApi(db, readMockConfig(''))
    env = api.env
    server = setupServer(...api.handlers)
    server.listen({ onUnhandledRequest: 'error' })
    const me = await send('GET', `${V1}/auth/me`)
    csrf = (me.body as { csrf_token: string }).csrf_token
  })
  afterAll(() => server.close())

  // Calls, checks the status and validates the body against the contract.
  async function check(
    method: string,
    template: string,
    path: string,
    status: number,
    opts: CallOpts = {},
  ): Promise<unknown> {
    const res = await send(method, path, { csrf, ...opts })
    expect(res.status, `${method} ${path} -> ${JSON.stringify(res.body)}`).toBe(status)
    expect(responseProblems(method, template, res.status, res.body)).toEqual([])
    if (status < 300) covered.add(`${method} ${template}`)
    return res.body
  }

  it('lists, adds, previews and removes group rules against the contract', async () => {
    const groupId = db.groups[0]!.id
    const base = `${V1}/groups/${groupId}/rules`
    const rule = (await check('POST', `${V1}/groups/{id}/rules`, base, 201, {
      body: { pattern: 't144-*' },
    })) as Schemas['GroupRule']
    await check('GET', `${V1}/group-rules`, `${V1}/group-rules`, 200)
    await check('POST', `${V1}/groups/{id}/rules/preview`, `${base}/preview`, 200, {
      body: { pattern: 't144-*' },
    })
    await check('POST', `${V1}/groups/{id}/rules`, base, 409, {
      body: { pattern: 'T144-*' },
    })
    await check('DELETE', `${V1}/groups/{id}/rules/{rule_id}`, `${base}/${rule.id}`, 204)
  })

  it('reads and updates sign-in duration against the contract', async () => {
    const path = `${V1}/settings/sessions`
    expect(await check('GET', path, path, 200)).toEqual({
      lifetime: 'browser',
      updated_at: null,
      updated_by: null,
    })
    expect(await check('PUT', path, path, 200, { body: { lifetime: '7d' } })).toMatchObject({
      lifetime: '7d',
    })
  })

  it('lists and reads devices', async () => {
    const list = (await check('GET', `${V1}/devices`, `${V1}/devices?limit=200`, 200)) as {
      items: Schemas['Device'][]
    }
    expect(list.items).toHaveLength(40)
    const pending = list.items.find((d) => d.state === 'pending')
    const approved = list.items.find((d) => d.state === 'approved' && d.online)
    const rejected = list.items.find((d) => d.state === 'rejected')
    expect(pending && approved && rejected).toBeTruthy()
    ids.pending = pending!.id
    ids.approved = approved!.id
    ids.rejected = rejected!.id
    await check('GET', `${V1}/devices/{id}`, `${V1}/devices/${ids.approved}`, 200)
    await check('GET', `${V1}/devices/{id}`, `${V1}/devices/not-a-uuid`, 404)
    await check('GET', `${V1}/devices`, `${V1}/devices?state=pending&online=true&q=a&limit=2`, 200)
  })

  it('filters ungrouped devices and rejects invalid or combined group filters', async () => {
    const all = (await send('GET', `${V1}/devices?limit=200`)).body as {
      items: Schemas['Device'][]
    }
    const onlyUngrouped = (await send('GET', `${V1}/devices?ungrouped=true&limit=200`)).body as {
      items: Schemas['Device'][]
    }
    expect(onlyUngrouped.items.map((d) => d.id)).toEqual(
      all.items.filter((d) => d.group_id === null).map((d) => d.id),
    )
    expect((await send('GET', `${V1}/devices?ungrouped=maybe`)).status).toBe(400)
    const group = db.groups[0]!
    expect((await send('GET', `${V1}/devices?group=${group.id}&ungrouped=true`)).status).toBe(400)

    const viewer = db.findUserByName('helpdesk')!
    const visibleGroup = db.groups[0]!
    const inGroup = db.deviceRows.find((device) => device.state === 'approved')!
    const assigned = db.deviceRows.find(
      (device) => device.state === 'approved' && device.id !== inGroup.id,
    )!
    const oldInGroup = inGroup.group_id
    const oldAssigned = assigned.group_id
    const oldGrants = db.grants.get(viewer.id)
    inGroup.group_id = visibleGroup.id
    assigned.group_id = null
    db.grants.set(viewer.id, { group_ids: [visibleGroup.id], device_ids: [assigned.id] })
    const previousUserId = env.session.userId
    try {
      env.session.userId = viewer.id
      const result = (await send('GET', `${V1}/devices?ungrouped=true&limit=200`)).body as {
        items: Schemas['Device'][]
      }
      expect(result.items.map((device) => device.id)).toEqual([assigned.id])
      expect(result.items[0]!.group_id).toBeNull()
    } finally {
      env.session.userId = previousUserId
      inGroup.group_id = oldInGroup
      assigned.group_id = oldAssigned
      if (oldGrants) db.grants.set(viewer.id, oldGrants)
      else db.grants.delete(viewer.id)
    }
  })

  it("gets and replaces a user's grants", async () => {
    const target = db.users.find((user) => user.username === 'helpdesk')
    expect(target).toBeTruthy()
    const devices = db.deviceRows.slice(0, 2)
    const body = { group_ids: [db.groups[0]!.id], device_ids: [devices[0]!.id] }
    const saved = await check(
      'PUT',
      `${V1}/users/{id}/grants`,
      `${V1}/users/${target!.id}/grants`,
      200,
      { body },
    )
    expect(saved).toEqual(body)
    expect(
      await check('GET', `${V1}/users/{id}/grants`, `${V1}/users/${target!.id}/grants`, 200),
    ).toEqual(body)
    covered.add(`GET ${V1}/users/{id}/grants`)
    covered.add(`PUT ${V1}/users/{id}/grants`)

    const duplicate = await send('PUT', `${V1}/users/${target!.id}/grants`, {
      csrf,
      body: { group_ids: [db.groups[0]!.id, db.groups[0]!.id], device_ids: [] },
    })
    expect(duplicate.status).toBe(400)
    expect(responseProblems('PUT', `${V1}/users/{id}/grants`, 400, duplicate.body)).toEqual([])
    const unknownUser = await send('GET', `${V1}/users/${SOME_UUID}/grants`, { csrf })
    expect(unknownUser.status).toBe(404)
    expect(responseProblems('GET', `${V1}/users/{id}/grants`, 404, unknownUser.body)).toEqual([])
    const admin = db.users.find((user) => user.username === 'sam')!
    const wrongRole = await send('PUT', `${V1}/users/${admin.id}/grants`, {
      csrf,
      body: { group_ids: [], device_ids: [] },
    })
    expect(wrongRole.status).toBe(409)
    expect(responseProblems('PUT', `${V1}/users/{id}/grants`, 409, wrongRole.body)).toEqual([])

    for (const badBody of [
      { group_ids: [SOME_UUID], device_ids: [] },
      { group_ids: [], device_ids: [SOME_UUID] },
      { group_ids: Array(257).fill(db.groups[0]!.id), device_ids: [] },
    ]) {
      const invalid = await send('PUT', `${V1}/users/${target!.id}/grants`, {
        csrf,
        body: badBody,
      })
      expect(invalid.status).toBe(400)
      expect(responseProblems('PUT', `${V1}/users/{id}/grants`, 400, invalid.body)).toEqual([])
    }
    const replacement = { group_ids: [], device_ids: [devices[1]!.id] }
    expect(
      await check('PUT', `${V1}/users/{id}/grants`, `${V1}/users/${target!.id}/grants`, 200, {
        body: replacement,
      }),
    ).toEqual(replacement)
    expect(
      await check('GET', `${V1}/users/{id}/grants`, `${V1}/users/${target!.id}/grants`, 200),
    ).toEqual(replacement)
    expect(db.auditLog[0]).toMatchObject({
      action: 'user.grants_updated',
      target_id: target!.id,
      details: {
        removed_group_ids: body.group_ids,
        added_device_ids: replacement.device_ids,
        removed_device_ids: body.device_ids,
      },
    })
  })

  it('serves OIDC and avatar contract operations', async () => {
    const pub = (await check(
      'GET',
      `${V1}/auth/oidc`,
      `${V1}/auth/oidc`,
      200,
    )) as Schemas['OIDCPublic']
    expect(pub).toEqual({ enabled: false, display_name: '' })
    const settings = (await check(
      'GET',
      `${V1}/settings/oidc`,
      `${V1}/settings/oidc`,
      200,
    )) as Schemas['OIDCSettings']
    expect(settings.client_secret_set).toBe(false)
    const invalid = await send('PATCH', `${V1}/settings/oidc`, {
      csrf,
      body: { enabled: true },
    })
    expect(invalid.status).toBe(400)
    expect(invalid.body).toMatchObject({ error: { code: 'bad_request' } })
    const result = (await check(
      'POST',
      `${V1}/settings/oidc/test`,
      `${V1}/settings/oidc/test`,
      200,
    )) as Schemas['OIDCTestResult']
    expect(result.error).toBe('unreachable')
    const saved = (await check('PATCH', `${V1}/settings/oidc`, `${V1}/settings/oidc`, 200, {
      body: {
        enabled: true,
        issuer: 'https://id.example',
        client_id: 'mock',
        client_secret: 'secret',
        owner_groups: ['owners'],
      },
    })) as Schemas['OIDCSettings']
    expect(saved.client_secret_set).toBe(true)
    expect(saved).not.toHaveProperty('client_secret')
    const successfulTest = (await check(
      'POST',
      `${V1}/settings/oidc/test`,
      `${V1}/settings/oidc/test`,
      200,
    )) as Schemas['OIDCTestResult']
    expect(successfulTest.ok).toBe(true)
    expect(readMockConfig('?mock-oidc=on').oidc).toBe(true)
    const avatar = await send('GET', `${V1}/users/${db.users[0]!.id}/avatar`)
    expect(avatar.status).toBe(404)
    expect(responseProblems('GET', `${V1}/users/{id}/avatar`, avatar.status, avatar.body)).toEqual(
      [],
    )
    covered.add(`GET ${V1}/users/{id}/avatar`)
    const start = await raw('GET', `${V1}/auth/oidc/start`, { redirect: 'manual' })
    expect(start.status).toBe(302)
    expect(start.headers.get('location')).toContain('/sign-in?sso_error=')
    const callback = await raw('GET', `${V1}/auth/oidc/callback`, { redirect: 'manual' })
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toContain('/sign-in?sso_error=')
    covered.add(`GET ${V1}/auth/oidc/start`)
    covered.add(`GET ${V1}/auth/oidc/callback`)
    const user = db.users[1]!
    db.passwords.delete(user.id)
    const unlink = await send('DELETE', `${V1}/users/${user.id}/oidc`, { csrf })
    expect(unlink.status).toBe(409)
    expect(unlink.body).toMatchObject({ error: { code: 'no_password' } })
    expect(responseProblems('DELETE', `${V1}/users/{id}/oidc`, unlink.status, unlink.body)).toEqual(
      [],
    )
    db.passwords.set(user.id, PASSWORD)
    const unlinked = await send('DELETE', `${V1}/users/${user.id}/oidc`, { csrf })
    expect(unlinked.status).toBe(200)
    expect(
      responseProblems('DELETE', `${V1}/users/{id}/oidc`, unlinked.status, unlinked.body),
    ).toEqual([])
    covered.add(`DELETE ${V1}/users/{id}/oidc`)
  })

  it('edits a device, its tags and group', async () => {
    const tags = (await check('GET', `${V1}/tags`, `${V1}/tags`, 200)) as {
      items: Schemas['Tag'][]
    }
    const groups = (await check('GET', `${V1}/groups`, `${V1}/groups`, 200)) as {
      items: Schemas['Group'][]
    }
    ids.group = groups.items[0]!.id
    ids.tag = tags.items[0]!.id
    const d = (await check('PATCH', `${V1}/devices/{id}`, `${V1}/devices/${ids.approved}`, 200, {
      body: { alias: 'front desk', note: 'n', group_id: ids.group, tag_ids: [ids.tag] },
    })) as Schemas['Device']
    expect(d.alias).toBe('front desk')
    expect(d.tags.map((t) => t.id)).toEqual([ids.tag])
    await check('PATCH', `${V1}/devices/{id}`, `${V1}/devices/${ids.approved}`, 400, {
      body: { group_id: SOME_UUID },
    })
    await check('PATCH', `${V1}/devices/{id}`, `${V1}/devices/${ids.approved}`, 400, {
      body: { nope: 1 },
    })
  })

  it('disconnects an open session once', async () => {
    const url = (id: string) => `${V1}/sessions/${id}/disconnect`
    const tpl = `${V1}/sessions/{id}/disconnect`
    const list = (await send('GET', `${V1}/sessions?limit=200`)).body as {
      items: Schemas['RemoteSession'][]
    }
    expect(list.items.every((s) => s.disconnect_requested_at === null)).toBe(true)
    const open = list.items.find((s) => s.ended_at === null)!
    const ended = list.items.find((s) => s.ended_at !== null)!
    const first = (await check('POST', tpl, url(open.id), 202)) as Schemas['RemoteSession']
    expect(first.disconnect_requested_at).not.toBeNull()
    expect(first.ended_at).toBeNull()
    const again = (await check('POST', tpl, url(open.id), 202)) as Schemas['RemoteSession']
    expect(again.disconnect_requested_at).toBe(first.disconnect_requested_at)
    const audit = db.auditLog.filter(
      (e) => e.action === 'session.disconnect_requested' && e.target_id === open.id,
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]!.details).toMatchObject({ device_id: open.device_id })
    await check('POST', tpl, url(ended.id), 409)
    await check('POST', tpl, url(SOME_UUID), 404)
  })

  it('moves devices through their states', async () => {
    const t = (op: string, id: string, status: number) =>
      check('POST', `${V1}/devices/{id}/${op}`, `${V1}/devices/${id}/${op}`, status)
    await t('approve', ids.pending!, 200)
    await t('approve', ids.pending!, 409)
    await t('archive', ids.pending!, 200)
    await t('restore', ids.pending!, 200)
    await t('reject', ids.approved!, 409)
    const reopened = (await t('reopen', ids.approved!, 200)) as Schemas['Device']
    expect(reopened.state).toBe('pending')
    expect(reopened.approved_by).toBeNull()
    expect(reopened.approved_at).toBeNull()
    const reopenAudit = db.auditLog.filter(
      (event) => event.action === 'device.reopened' && event.target_id === ids.approved,
    )
    expect(reopenAudit).toHaveLength(1)
    expect(reopenAudit[0]!.details).toMatchObject({ from: 'approved', to: 'pending' })
    await t('reopen', ids.approved!, 409)
    await t('approve', ids.approved!, 200)
    await t('archive', ids.approved!, 200)
    await t('reopen', ids.approved!, 409)
    await t('restore', ids.approved!, 200)
    await t('approve', ids.rejected!, 200)
    const list = (await send('GET', `${V1}/devices?state=pending&limit=200`)).body as {
      items: Schemas['Device'][]
    }
    await t('reject', list.items[0]!.id, 200)
    await t('reopen', list.items[0]!.id, 200)
    await t('reopen', list.items[0]!.id, 409)
    await t('approve', SOME_UUID, 404)
  })

  it('resolves alerts and hands out connect links', async () => {
    const list = (await send('GET', `${V1}/devices?limit=200`)).body as {
      items: Schemas['Device'][]
    }
    const withAlert = list.items.find((d) => d.open_alerts.length > 0)
    expect(withAlert, 'medium has a device with an open alert').toBeTruthy()
    const alert = withAlert!.open_alerts[0]!
    const tpl = `${V1}/devices/{id}/alerts/{alert_id}/resolve`
    const url = `${V1}/devices/${withAlert!.id}/alerts/${alert.id}/resolve`
    await check('POST', tpl, url, 400, { body: { action: 'ignore' } })
    const resolved = (await check('POST', tpl, url, 200, {
      body: { action: 'accept_new_uuid' },
    })) as Schemas['Device']
    expect(resolved.open_alerts).toHaveLength(0)
    expect(resolved.uuid).toBe(alert.seen_uuid)
    await check('POST', tpl, url, 404, { body: { action: 'dismiss' } })

    const link = (await check(
      'GET',
      `${V1}/devices/{id}/connect`,
      `${V1}/devices/${ids.approved}/connect?action=file-transfer&relay=1`,
      200,
    )) as { url: string; id: string }
    expect(link.url).toMatch(/^rustdesk:\/\/file-transfer\/\d+\/r@.+\?key=.+/)
    db.server!.links_include_server = false
    const plainLink = (await check(
      'GET',
      `${V1}/devices/{id}/connect`,
      `${V1}/devices/${ids.approved}/connect?action=file-transfer&relay=1`,
      200,
    )) as { url: string; includes_server: boolean }
    expect(plainLink.url).toMatch(/^rustdesk:\/\/file-transfer\/\d+\/r$/)
    expect(plainLink.includes_server).toBe(false)
    const unapproved = list.items.find((d) => d.state === 'pending' || d.state === 'rejected')!
    await check('GET', `${V1}/devices/{id}/connect`, `${V1}/devices/${unapproved.id}/connect`, 404)
    const archived = list.items.find((d) => d.state === 'archived')!
    await check('GET', `${V1}/devices/{id}/connect`, `${V1}/devices/${archived.id}/connect`, 404)
  })

  it('manages groups', async () => {
    const g = (await check('POST', `${V1}/groups`, `${V1}/groups`, 201, {
      body: { name: 'Lab' },
    })) as Schemas['Group']
    await check('POST', `${V1}/groups`, `${V1}/groups`, 409, { body: { name: 'lab' } })
    await check('PATCH', `${V1}/groups/{id}`, `${V1}/groups/${g.id}`, 200, {
      body: { name: 'Lab 2' },
    })
    const child = (await check('POST', `${V1}/groups`, `${V1}/groups`, 201, {
      body: { name: 'Bench', parent_id: g.id },
    })) as Schemas['Group']
    await check('POST', `${V1}/groups/{id}/move`, `${V1}/groups/${g.id}/move`, 409, {
      body: { parent_id: child.id },
    })
    await check('DELETE', `${V1}/groups/{id}`, `${V1}/groups/${g.id}`, 409)
    await check('POST', `${V1}/groups/{id}/move`, `${V1}/groups/${child.id}/move`, 200, {
      body: { parent_id: null },
    })
    await check('DELETE', `${V1}/groups/{id}`, `${V1}/groups/${g.id}`, 204)
    // ids.group holds a device (set in the device edit test)
    await check('DELETE', `${V1}/groups/{id}`, `${V1}/groups/${ids.group}`, 409)
  })

  it('manages tags', async () => {
    const t = (await check('POST', `${V1}/tags`, `${V1}/tags`, 201, {
      body: { name: 'Temp', color: 4280391411 },
    })) as Schemas['Tag']
    await check('POST', `${V1}/tags`, `${V1}/tags`, 409, { body: { name: 'TEMP' } })
    await check('PATCH', `${V1}/tags/{id}`, `${V1}/tags/${t.id}`, 200, { body: { color: 1 } })
    await check('DELETE', `${V1}/tags/{id}`, `${V1}/tags/${t.id}`, 204)
    await check('DELETE', `${V1}/tags/{id}`, `${V1}/tags/${t.id}`, 404)
  })

  it('manages users (owner)', async () => {
    const list = (await check('GET', `${V1}/users`, `${V1}/users`, 200)) as {
      items: Schemas['User'][]
    }
    const owner = list.items.find((u) => u.role === 'owner')!
    const u = (await check('POST', `${V1}/users`, `${V1}/users`, 201, {
      body: { username: 'newbie', password: PASSWORD, role: 'admin' },
    })) as Schemas['User']
    await check('POST', `${V1}/users`, `${V1}/users`, 409, {
      body: { username: 'NEWBIE', password: PASSWORD, role: 'admin' },
    })
    await check('POST', `${V1}/users`, `${V1}/users`, 400, {
      body: { username: 'weak', password: 'short', role: 'admin' },
    })
    await check('PATCH', `${V1}/users/{id}`, `${V1}/users/${u.id}`, 200, {
      body: { display_name: 'Newbie', status: 'disabled' },
    })
    await check('PATCH', `${V1}/users/{id}`, `${V1}/users/${owner.id}`, 409, {
      body: { role: 'admin' },
    })
    await check('POST', `${V1}/users/{id}/reset-totp`, `${V1}/users/${u.id}/reset-totp`, 200)
  })

  it("sets another account's password (owner)", async () => {
    const list = (await check('GET', `${V1}/users`, `${V1}/users`, 200)) as {
      items: Schemas['User'][]
    }
    const me = (
      (await check('GET', `${V1}/auth/me`, `${V1}/auth/me`, 200)) as {
        user: Schemas['User']
      }
    ).user
    expect(list.items.some((x) => x.id !== me.id)).toBe(true)
    const target = (await check('POST', `${V1}/users`, `${V1}/users`, 201, {
      body: { username: 'long.username.x', password: PASSWORD, role: 'admin' },
    })) as Schemas['User']
    const path = `${V1}/users/${target.id}/password`
    const tpl = `${V1}/users/{id}/password`
    const bad = async (status: number, password: string) =>
      check('POST', tpl, path, status, { body: { password } })
    await bad(400, 'short')
    await bad(400, 'password1234')
    await bad(400, 'LONG.USERNAME.X')
    await bad(400, '�'.repeat(513))
    await check('POST', tpl, `${V1}/users/${me.id}/password`, 400, {
      body: { password: 'a brand new passphrase' },
    })
    await check('POST', tpl, `${V1}/users/3c9d1f7a-5b2e-4d8a-8f61-0a1b2c3d4e5f/password`, 404, {
      body: { password: 'a brand new passphrase' },
    })
    await check('POST', tpl, path, 400, { body: { password: 'a brand new passphrase', x: 1 } })
    expect(db.passwords.get(target.id)).not.toBe('a brand new passphrase')
    const body = (await check('POST', tpl, path, 200, {
      body: { password: 'a brand new passphrase' },
    })) as Schemas['User']
    expect(body.id).toBe(target.id)
    expect(db.passwords.get(target.id)).toBe('a brand new passphrase')
    expect(db.auditLog[0]).toMatchObject({ action: 'user.password_reset', target_id: target.id })
    expect(JSON.stringify(db.auditLog[0])).not.toContain('passphrase')
  })

  it('serves and edits the server profile', async () => {
    await check('GET', `${V1}/server`, `${V1}/server`, 200)
    await check('PATCH', `${V1}/server`, `${V1}/server`, 200, { body: { name: 'home' } })
    await check('PATCH', `${V1}/server`, `${V1}/server`, 400, { body: { public_key: 'nope' } })
    await check('POST', `${V1}/server/check`, `${V1}/server/check`, 200)
    await check('GET', `${V1}/server/health`, `${V1}/server/health`, 200)
    await check('GET', `${V1}/server/client-config`, `${V1}/server/client-config`, 200)
  })

  it('serves the deployment profile and a script without exposing secrets', async () => {
    const path = `${V1}/deployment/profile`
    const script = `${V1}/deployment/script`
    const initial = (await check('GET', path, path, 200)) as Schemas['DeploymentProfile']
    expect(initial).toMatchObject({
      installer_source: 'github',
      client_version: 'latest',
      include_install: true,
      password: { set: false },
      unlock_pin: { set: false },
      updated_at: null,
    })
    const {
      catalog: _catalog,
      password: _password,
      unlock_pin: _pin,
      updated_at: _updated,
      ...editable
    } = initial
    void _catalog
    void _password
    void _pin
    void _updated
    const latestSaved = (await check('PUT', path, path, 200, {
      body: editable,
    })) as Schemas['DeploymentProfile']
    const contradiction = await send('PUT', path, {
      csrf,
      body: {
        ...editable,
        settings: {
          'enable-file-transfer': { include: true, value: 'N' },
          'access-mode': { include: true, value: 'view' },
        },
      },
    })
    expect(contradiction.status).toBe(400)
    expect(contradiction.body).toMatchObject({
      error: { message: 'access-mode: must be custom when individual permissions are managed' },
    })
    expect(latestSaved.client_version).toBe('latest')
    const invalidLatest = await send('PUT', path, {
      csrf,
      body: { ...editable, installer_source: 'url' },
    })
    expect(invalidLatest.status).toBe(400)
    expect(invalidLatest.body).toMatchObject({
      error: {
        code: 'bad_request',
        message: 'client_version: latest needs the GitHub installer source',
      },
    })
    for (const field of ['sha256_windows', 'sha256_deb', 'sha256_rpm']) {
      const invalidChecksum = await send('PUT', path, {
        csrf,
        body: { ...editable, [field]: 'a'.repeat(64) },
      })
      expect(invalidChecksum.status).toBe(400)
      expect(invalidChecksum.body).toMatchObject({
        error: { code: 'bad_request', message: `${field}: not allowed with the latest release` },
      })
    }
    const saved = (await check('PUT', path, path, 200, {
      body: { ...editable, fleet_password: 'Password123', unlock_pin: '1234' },
    })) as Schemas['DeploymentProfile']
    expect(saved.password.set).toBe(true)
    expect(saved.unlock_pin.set).toBe(true)
    expect(JSON.stringify(saved)).not.toContain('Password123')
    expect(JSON.stringify(saved)).not.toContain('1234')
    expect(
      JSON.stringify(db.auditLog.filter((entry) => entry.action.startsWith('deployment.'))),
    ).not.toContain('Password123')
    await check('PUT', path, path, 200, { body: editable })
    expect(
      ((await check('GET', path, path, 200)) as Schemas['DeploymentProfile']).password.set,
    ).toBe(true)
    const removed = (await check('PUT', path, path, 200, {
      body: { ...editable, fleet_password: null, unlock_pin: null },
    })) as Schemas['DeploymentProfile']
    expect(removed.password.set).toBe(false)
    expect(removed.unlock_pin.set).toBe(false)

    for (const os of ['windows', 'linux'] as const) {
      const response = await raw('POST', script, { csrf, body: { os } })
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
      expect(response.headers.get('Content-Disposition')).toBe(
        `attachment; filename=ferricade-deploy.${os === 'windows' ? 'ps1' : 'sh'}`,
      )
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.text()).toBe('# ferricade deployment script\n')
      expect(responseProblems('POST', script, response.status, undefined)).toEqual([])
      covered.add(`POST ${script}`)
    }
  })

  it('keeps the latest health checks when Check now runs', async () => {
    const controls = createMockControls(env)
    controls.setServerCheck('relay', false, 'connection refused')
    const since = env.health.checks.find((check) => check.name === 'relay')!.since

    const result = (await check('POST', `${V1}/server/check`, `${V1}/server/check`, 200)) as {
      checks: Schemas['Check'][]
    }
    expect(result.checks).toContainEqual({
      name: 'relay',
      ok: false,
      detail: 'connection refused',
      target: 'rd.example.com:21117',
      address: '203.0.113.10:21117',
      reason: 'refused',
    })

    const health = (await check(
      'GET',
      `${V1}/server/health`,
      `${V1}/server/health`,
      200,
    )) as Schemas['ServerHealth']
    expect(health.checks.find((check) => check.name === 'relay')?.since).toBe(since)
    expect(health.checks.find((check) => check.name === 'relay')).toMatchObject({
      target: 'rd.example.com:21117',
      address: '203.0.113.10:21117',
      reason: 'refused',
    })
  })

  it('uses api_url for manual and health client API check targets', async () => {
    const path = `${V1}/server`
    await check('PATCH', path, path, 200, { body: { api_url: 'https://api.example.com:8443' } })

    const manual = (await check('POST', `${V1}/server/check`, `${V1}/server/check`, 200)) as {
      checks: Schemas['Check'][]
    }
    expect(manual.checks.find((check) => check.name === 'client-api')?.target).toBe(
      'api.example.com:8443',
    )

    const health = (await check(
      'GET',
      `${V1}/server/health`,
      `${V1}/server/health`,
      200,
    )) as Schemas['ServerHealth']
    expect(health.checks.find((check) => check.name === 'client-api')?.target).toBe(
      'api.example.com:8443',
    )

    await check('PATCH', path, path, 200, { body: { api_url: '' } })
  })

  it('serves audit, sessions and statistics', async () => {
    const page = (await check('GET', `${V1}/audit`, `${V1}/audit?limit=5`, 200)) as {
      items: Schemas['AuditEvent'][]
      next_cursor: string
    }
    expect(page.items).toHaveLength(5)
    expect(page.next_cursor).not.toBe('')
    await check('GET', `${V1}/audit`, `${V1}/audit?limit=5&cursor=${page.next_cursor}`, 200)
    await check('GET', `${V1}/audit`, `${V1}/audit?action=device.approved`, 200)
    await check('GET', `${V1}/audit`, `${V1}/audit?limit=0`, 400)
    await check('GET', `${V1}/sessions`, `${V1}/sessions?active=true`, 200)
    await check('GET', `${V1}/sessions`, `${V1}/sessions?authenticated=true&limit=10`, 200)
    const stats = (await check(
      'GET',
      `${V1}/sessions/stats`,
      `${V1}/sessions/stats?range=30d&tz=Europe/Berlin`,
      200,
    )) as Schemas['SessionStats']
    expect(stats.per_day).toHaveLength(30)
    await check('GET', `${V1}/sessions/stats`, `${V1}/sessions/stats?range=1y`, 400)
    for (const r of ['24h', '7d', '30d']) {
      await check('GET', `${V1}/stats/history`, `${V1}/stats/history?range=${r}`, 200)
    }
    await check('GET', `${V1}/stats/history`, `${V1}/stats/history`, 400)
    await check('GET', `${V1}/stats/summary`, `${V1}/stats/summary`, 200)
    await check('GET', `${V1}/stats/fleet-map`, `${V1}/stats/fleet-map`, 200)
  })

  it('serves settings, catalog and preferences', async () => {
    await check('GET', `${V1}/settings/log-export`, `${V1}/settings/log-export`, 200)
    await check('PUT', `${V1}/settings/log-export`, `${V1}/settings/log-export`, 200, {
      body: {
        file: { enabled: true },
        syslog: {
          enabled: false,
          host: '',
          port: 6514,
          tls: true,
          ca_pem: '',
          facility: 'local0',
          format: 'json',
        },
      },
    })
    await check('POST', `${V1}/settings/log-export/test`, `${V1}/settings/log-export/test`, 200, {
      body: { output: 'file' },
    })
    await check('GET', `${V1}/settings/dashboard`, `${V1}/settings/dashboard`, 200)
    await check('PUT', `${V1}/settings/dashboard`, `${V1}/settings/dashboard`, 200, {
      body: { offline_days: 3, pending_hours: 12, min_client_version: '1.4.0' },
    })
    await check('PUT', `${V1}/settings/dashboard`, `${V1}/settings/dashboard`, 400, {
      body: { offline_days: 0, pending_hours: 12, min_client_version: '' },
    })
    const catalog = (await check(
      'GET',
      `${V1}/dashboard/catalog`,
      `${V1}/dashboard/catalog`,
      200,
    )) as Schemas['DashboardCatalog']
    expect(catalog.modules).toHaveLength(11)
    const prefs = (await check(
      'GET',
      `${V1}/me/preferences`,
      `${V1}/me/preferences`,
      200,
    )) as Schemas['Preferences']
    expect(prefs.preset).toBe('business')
    expect(prefs.palette).toBe('default')
    expect(prefs.toast_seconds).toBe(5)
    const next: Schemas['Preferences'] = {
      ...prefs,
      preset: 'custom',
      theme: 'light',
      palette: 'moss',
    }
    const saved = await check('PUT', `${V1}/me/preferences`, `${V1}/me/preferences`, 200, {
      body: next,
    })
    expect(saved).toMatchObject({ preset: 'custom', theme: 'light', palette: 'moss' })
    const omitted = await check('PUT', `${V1}/me/preferences`, `${V1}/me/preferences`, 200, {
      body: {
        preset: 'custom',
        modules: prefs.modules,
        pinned_device_ids: [],
        theme: 'light',
        density: 'comfortable',
      },
    })
    expect(omitted).toMatchObject({ palette: 'moss' })
    const durationSaved = await check('PUT', `${V1}/me/preferences`, `${V1}/me/preferences`, 200, {
      body: { ...prefs, toast_seconds: 10 },
    })
    expect(durationSaved).toMatchObject({ toast_seconds: 10 })
    const durationOmitted = await check(
      'PUT',
      `${V1}/me/preferences`,
      `${V1}/me/preferences`,
      200,
      {
        body: { ...prefs, toast_seconds: undefined },
      },
    )
    expect(durationOmitted).toMatchObject({ toast_seconds: 10 })
    for (const toast_seconds of [7, '10']) {
      const invalid = await check('PUT', `${V1}/me/preferences`, `${V1}/me/preferences`, 400, {
        body: { ...prefs, toast_seconds },
      })
      expect(invalid).toMatchObject({ error: { code: 'bad_request' } })
    }
    for (const palette of ['neon', '', 7]) {
      const invalid = await check('PUT', `${V1}/me/preferences`, `${V1}/me/preferences`, 400, {
        body: { ...prefs, palette },
      })
      expect(invalid).toMatchObject({
        error: {
          code: 'bad_request',
          message: 'palette must be default, graphite, ocean, violet, moss or sandstone',
        },
      })
    }
    await check('PUT', `${V1}/me/preferences`, `${V1}/me/preferences`, 400, {
      body: { ...prefs, modules: [{ id: 'nope', enabled: true }] },
    })
  })

  it('manages policies, group inheritance and the push switch', async () => {
    const policies = `${V1}/policies`
    const policyPath = `${V1}/policies/{id}`
    const push = `${V1}/settings/policy-push`
    const allowList = `${V1}/settings/id-allow-list`
    const groupPath = `${V1}/groups/{id}/policy`
    const listed = (await check('GET', policies, policies, 200)) as { items: Schemas['Policy'][] }
    await check('GET', allowList, allowList, 200)
    await check('PUT', allowList, allowList, 200, { body: { ids: ['Global_1'] } })
    expect(listed.items).toHaveLength(1)
    const defaultId = listed.items[0]!.id
    expect(listed.items[0]).toMatchObject({ is_default: true, updated_by: null })
    const settings = {
      'approve-mode': 'password-click',
      'verification-method': 'use-both-passwords',
      'enable-file-transfer': 'N',
    }
    const created = (await check('POST', policies, policies, 201, {
      body: { name: 'Office policy', settings },
    })) as Schemas['Policy']
    expect(created.settings).toEqual(settings)
    expect(created.updated_by?.id).toBeTruthy()
    expect(
      (await check('GET', policyPath, `${policies}/${created.id}`, 200)) as Schemas['Policy'],
    ).toEqual(created)
    expect(
      ((await check('GET', policies, policies, 200)) as { items: Schemas['Policy'][] }).items.map(
        (p) => p.id,
      ),
    ).toEqual([defaultId, created.id])
    const renamed = (await check('PATCH', policyPath, `${policies}/${created.id}`, 200, {
      body: { name: 'Office renamed' },
    })) as Schemas['Policy']
    expect(renamed.settings).toEqual(settings)
    const bad = (await check('POST', policies, policies, 400, {
      body: { name: 'Bad', settings: { ...settings, 'custom-rendezvous-server': 'x' } },
    })) as { error: { message: string } }
    expect(bad.error.message).toBe('custom-rendezvous-server: not a catalog setting')
    const contradictory = (await check('POST', policies, policies, 400, {
      body: { name: 'Bad preset', settings: { ...settings, 'access-mode': 'full' } },
    })) as { error: { message: string } }
    expect(contradictory.error.message).toBe(
      'access-mode: must be custom when individual permissions are managed',
    )
    expect(
      (await check('POST', policies, policies, 409, {
        body: { name: 'Office renamed', settings },
      })) as { error: { code: string } },
    ).toMatchObject({ error: { code: 'name_taken' } })
    expect(
      (await check('PATCH', policyPath, `${policies}/${defaultId}`, 409, {
        body: { name: 'Changed' },
      })) as { error: { code: string } },
    ).toMatchObject({ error: { code: 'default_policy' } })
    expect(
      (await check('DELETE', policyPath, `${policies}/${defaultId}`, 409)) as {
        error: { code: string }
      },
    ).toMatchObject({ error: { code: 'default_policy' } })
    const parent = db.groups.find((g) => g.name === 'Office')!
    await check(
      'GET',
      `${V1}/groups/{id}/id-allow-list`,
      `${V1}/groups/${parent.id}/id-allow-list`,
      200,
    )
    await check(
      'PUT',
      `${V1}/groups/{id}/id-allow-list`,
      `${V1}/groups/${parent.id}/id-allow-list`,
      200,
      {
        body: { ids: ['Group__1'] },
      },
    )
    const child = db.groups.find((g) => g.parent_id === parent.id)!
    const assigned = (await check('PUT', groupPath, `${V1}/groups/${parent.id}/policy`, 200, {
      body: { policy_id: created.id },
    })) as Schemas['Group']
    expect(assigned).toMatchObject({ policy_id: created.id, effective_policy_id: created.id })
    const tree = (await check('GET', `${V1}/groups`, `${V1}/groups`, 200)) as {
      items: Schemas['Group'][]
    }
    expect(
      tree.items.find((g) => g.id === parent.id)?.children.find((g) => g.id === child.id)
        ?.effective_policy_id,
    ).toBe(created.id)
    expect(
      (await check('DELETE', policyPath, `${policies}/${created.id}`, 409)) as {
        error: { code: string }
      },
    ).toMatchObject({ error: { code: 'in_use' } })
    const cleared = (await check('PUT', groupPath, `${V1}/groups/${parent.id}/policy`, 200, {
      body: { policy_id: null },
    })) as Schemas['Group']
    expect(cleared).toMatchObject({ policy_id: null, effective_policy_id: defaultId })
    await check('DELETE', policyPath, `${policies}/${created.id}`, 204)
    await check('GET', policyPath, `${policies}/${created.id}`, 404)
    expect((await check('GET', push, push, 200)) as Schemas['PolicyPush']).toMatchObject({
      enabled: false,
      updated_by: null,
    })
    const enabled = (await check('PUT', push, push, 200, {
      body: { enabled: true },
    })) as Schemas['PolicyPush']
    expect(enabled.enabled).toBe(true)
    expect((await check('GET', push, push, 200)) as Schemas['PolicyPush']).toEqual(enabled)
    expect(db.auditLog.some((entry) => entry.action === 'group.policy_changed')).toBe(true)
    expect(db.auditLog.some((entry) => entry.action === 'policy_push.enabled')).toBe(true)
  })

  it('serves device policy status and access-window operations', async () => {
    const deviceId = ids.approved!
    const policyPath = `${V1}/devices/{id}/policy`
    const openPath = `${V1}/devices/{id}/access-window`
    const closePath = `${V1}/devices/{id}/access-window/close`
    const base = `${V1}/devices/${deviceId}`
    await check('GET', `${V1}/devices/{id}/id-allow-list`, `${base}/id-allow-list`, 200)
    await check('PUT', `${V1}/devices/{id}/id-allow-list`, `${base}/id-allow-list`, 200, {
      body: { ids: ['Device_1'] },
    })
    const owner = db.users.find((u) => u.role === 'owner')!
    const defaultPolicy = db.policies.find((p) => p.is_default)!
    db.updatePolicy(
      defaultPolicy.id,
      undefined,
      {
        'approve-mode': 'click',
        'verification-method': 'use-both-passwords',
      },
      owner,
    )
    const status = (await check(
      'GET',
      policyPath,
      `${base}/policy`,
      200,
    )) as Schemas['DevicePolicyStatus']
    expect(status).toMatchObject({
      push_enabled: true,
      status: 'pending',
      connect: 'attended',
      window: null,
      always_reachable: false,
    })
    const connectPath = `${V1}/devices/{id}/connect`
    db.updatePolicy(
      defaultPolicy.id,
      undefined,
      { 'approve-mode': 'password', 'verification-method': 'use-temporary-password' },
      owner,
    )
    expect(await check('GET', policyPath, `${base}/policy`, 200)).toMatchObject({
      connect: 'locked',
    })
    const linksBefore = db.auditLog.filter((entry) => entry.action === 'device.connect_link').length
    expect(await check('GET', connectPath, `${base}/connect`, 409)).toMatchObject({
      error: { code: 'access_locked', message: 'Locked by policy. Allow access first.' },
    })
    expect(db.auditLog.filter((entry) => entry.action === 'device.connect_link')).toHaveLength(
      linksBefore,
    )
    const body = { duration_minutes: 60, disconnect_on_close: false }
    const window = (await check('POST', openPath, `${base}/access-window`, 201, {
      body,
    })) as Schemas['AccessWindow']
    expect(window.ends_at).toBeTruthy()
    expect(await check('GET', policyPath, `${base}/policy`, 200)).toMatchObject({
      connect: 'window',
      window: { id: window.id },
    })
    await check('GET', connectPath, `${base}/connect`, 200)
    expect(await check('POST', openPath, `${base}/access-window`, 409, { body })).toMatchObject({
      error: { code: 'window_open' },
    })
    const pushPath = `${V1}/settings/policy-push`
    expect(await check('PUT', pushPath, pushPath, 409, { body: { enabled: false } })).toMatchObject(
      {
        error: { code: 'window_open' },
      },
    )
    for (const suffix of ['archive', 'reopen'] as const) {
      expect(
        await check('POST', `${V1}/devices/{id}/${suffix}`, `${base}/${suffix}`, 409),
      ).toMatchObject({
        error: { code: 'window_open' },
      })
    }
    expect(await check('DELETE', `${V1}/devices/{id}`, base, 409)).toMatchObject({
      error: { code: 'window_open' },
    })
    await check('POST', closePath, `${base}/access-window/close`, 204, {
      body: { disconnect: false },
    })
    expect(await check('GET', policyPath, `${base}/policy`, 200)).toMatchObject({
      window: null,
      connect: 'locked',
    })
    db.updatePolicy(
      defaultPolicy.id,
      undefined,
      { 'approve-mode': 'click', 'verification-method': 'use-both-passwords' },
      owner,
    )
    expect(await check('GET', policyPath, `${base}/policy`, 200)).toMatchObject({
      connect: 'attended',
    })
    await check('GET', connectPath, `${base}/connect`, 200)
    db.setDeviceVersionSeen(deviceId, true)
    db.deviceVersionSeen.set(deviceId, false)
    expect(await check('GET', policyPath, `${base}/policy`, 200)).toMatchObject({
      close_unconfirmed_since: null,
    })
    await check('POST', closePath, `${base}/access-window/close`, 404, {
      body: { disconnect: false },
    })
    await check('POST', openPath, `${base}/access-window`, 400, {
      body: { duration_minutes: 30, disconnect_on_close: false },
    })
    await check('GET', policyPath, `${V1}/devices/${SOME_UUID}/policy`, 404)
  })

  // After the device tests (they would miss the deleted device), before the
  // account tests sign out.
  it('deletes a device with its sessions, in any state', async () => {
    const sessions = (await send('GET', `${V1}/sessions?limit=200`)).body as {
      items: Schemas['RemoteSession'][]
    }
    const id = sessions.items[0]!.device_id
    const path = `${V1}/devices/${id}`
    await check('DELETE', `${V1}/devices/{id}`, path, 204)
    await check('GET', `${V1}/devices/{id}`, path, 404)
    await check('DELETE', `${V1}/devices/{id}`, path, 404)
    const after = (await send('GET', `${V1}/sessions?limit=200`)).body as {
      items: Schemas['RemoteSession'][]
    }
    expect(after.items.some((s) => s.device_id === id)).toBe(false)
    const audit = (await send('GET', `${V1}/audit?action=device.deleted`)).body as {
      items: Schemas['AuditEvent'][]
    }
    expect(audit.items[0]?.target_id).toBe(id)
  })

  it('handles the account endpoints', async () => {
    await check('GET', `${V1}/auth/me`, `${V1}/auth/me`, 200)
    await check('POST', `${V1}/auth/password`, `${V1}/auth/password`, 403, {
      body: { current_password: 'wrong password!!', new_password: 'a much longer password' },
    })
    await check('POST', `${V1}/auth/password`, `${V1}/auth/password`, 400, {
      body: { current_password: PASSWORD, new_password: 'short' },
    })
    await check('POST', `${V1}/auth/totp/enroll`, `${V1}/auth/totp/enroll`, 200)
    await check('POST', `${V1}/auth/totp/enroll/verify`, `${V1}/auth/totp/enroll/verify`, 400, {
      body: { code: '654321' },
    })
    const v = (await check(
      'POST',
      `${V1}/auth/totp/enroll/verify`,
      `${V1}/auth/totp/enroll/verify`,
      200,
      { body: { code: '123456' } },
    )) as Schemas['CSRFToken']
    csrf = v.csrf_token
    const changed = (await check('POST', `${V1}/auth/password`, `${V1}/auth/password`, 200, {
      body: { current_password: PASSWORD, new_password: 'a much longer password' },
    })) as Schemas['CSRFToken']
    csrf = changed.csrf_token
    await check('POST', `${V1}/auth/totp`, `${V1}/auth/totp`, 400, { body: { code: '654321' } })
    await check('POST', `${V1}/auth/totp`, `${V1}/auth/totp`, 400, { body: { code: '000000' } })
    const t = (await check('POST', `${V1}/auth/totp`, `${V1}/auth/totp`, 200, {
      body: { code: '123456' },
    })) as Schemas['CSRFToken']
    csrf = t.csrf_token
    await check('POST', `${V1}/auth/logout`, `${V1}/auth/logout`, 204)
    await check('GET', `${V1}/auth/me`, `${V1}/auth/me`, 401)
    await check('POST', `${V1}/auth/login`, `${V1}/auth/login`, 401, {
      csrf: null,
      body: { username: 'alex', password: 'nope nope nope' },
    })
    const login = (await check('POST', `${V1}/auth/login`, `${V1}/auth/login`, 200, {
      csrf: null,
      body: { username: 'alex', password: 'a much longer password' },
    })) as { mfa_required: boolean; csrf_token: string }
    expect(login.mfa_required).toBe(true)
  })

  it('leaves the setup operations to the setup suite and /events to the stream test', () => {
    for (const op of contractOperations()) {
      if (op.includes(' /setup/') || op.endsWith('/events')) covered.add(op)
    }
  })

  it('exercised every operation with a 2xx response', () => {
    expect(contractOperations().filter((op) => !covered.has(op))).toEqual([])
  })
})

describe('first-run setup (?mock-setup=incomplete)', () => {
  let db: MockDB
  let server: Server
  const tok = { setupToken: 'mock-setup-token' }
  beforeAll(() => {
    db = createMockDB('small')
    server = use(db, readMockConfig('?mock-setup=incomplete'))
  })
  afterAll(() => server.close())

  async function check(method: string, path: string, status: number, opts: CallOpts = {}) {
    const res = await send(method, path, opts)
    expect(res.status, `${method} ${path} -> ${JSON.stringify(res.body)}`).toBe(status)
    expect(responseProblems(method, path, res.status, res.body)).toEqual([])
    return res.body
  }

  it('has no session before setup', async () => {
    await check('GET', `${V1}/auth/me`, 401)
  })

  it('walks the wizard and then locks /setup', async () => {
    expect(await check('GET', '/setup/status', 200)).toEqual({ setup_complete: false })
    await check('POST', '/setup/owner', 401, { body: { username: 'me', password: PASSWORD } })
    await check('POST', '/setup/owner/totp', 409, tok)
    await check('POST', '/setup/owner', 400, {
      ...tok,
      body: { username: 'me', password: 'short' },
    })
    await check('POST', '/setup/owner', 201, {
      ...tok,
      body: { username: 'me', password: PASSWORD },
    })
    await check('POST', '/setup/complete', 409, tok)
    await check('POST', '/setup/owner/totp', 200, tok)
    await check('POST', '/setup/owner/totp/verify', 400, { ...tok, body: { code: '111111' } })
    expect(
      await check('POST', '/setup/owner/totp/verify', 200, { ...tok, body: { code: '123456' } }),
    ).toEqual({ verified: true })
    await check('POST', '/setup/server', 400, {
      ...tok,
      body: { id_host: 'rd.example.com', relay_host: 'rd.example.com', public_key: 'bad' },
    })
    const saved = (await check('POST', '/setup/server', 200, {
      ...tok,
      body: {
        id_host: 'rd.example.com',
        relay_host: 'rd.example.com',
        public_key: 'OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=',
      },
    })) as { checks: Schemas['Check'][] }
    expect(saved.checks.map((c) => c.name)).toEqual([
      'id-server',
      'relay',
      'client-api',
      'hbbs-online-query',
    ])
    const done = (await check('POST', '/setup/complete', 200, tok)) as {
      client_config: Schemas['ClientConfig']
    }
    expect(done.client_config.host).toBe('rd.example.com')
    expect(await check('GET', '/setup/status', 200)).toEqual({ setup_complete: true })
    await check('POST', '/setup/complete', 404, tok)
    // the owner just created can sign in
    await check('POST', `${V1}/auth/login`, 200, { body: { username: 'me', password: PASSWORD } })
  })
})

describe('behaviour switches', () => {
  let server: Server | undefined
  afterEach(() => {
    server?.close()
    server = undefined
  })

  it('reads the URL query', () => {
    expect(readMockConfig('')).toMatchObject({
      size: 'medium',
      delayMs: 0,
      role: 'owner',
      setupIncomplete: false,
    })
    const c = readMockConfig(
      '?mock=large&mock-delay=250&mock-fail=listDevices,getServer&mock-role=admin&mock-setup=incomplete',
    )
    expect(c.size).toBe('large')
    expect(c.delayMs).toBe(250)
    expect([...c.failOperations]).toEqual(['listDevices', 'getServer'])
    expect(c.role).toBe('admin')
    expect(c.setupIncomplete).toBe(true)
    // junk falls back to the defaults
    expect(readMockConfig('?mock=huge&mock-delay=-5&mock-role=root')).toMatchObject({
      size: 'medium',
      delayMs: 0,
      role: 'owner',
    })
  })

  it('has 3, 40 and 400 devices', async () => {
    for (const [size, n] of [
      ['small', 3],
      ['medium', 40],
      ['large', 400],
    ] as const) {
      server = use(createMockDB(size), readMockConfig(''))
      let total = 0
      let cursor = ''
      do {
        const res = await send('GET', `${V1}/devices?limit=200&cursor=${cursor}`)
        const page = res.body as { items: unknown[]; next_cursor: string }
        total += page.items.length
        cursor = page.next_cursor
      } while (cursor)
      expect(total, size).toBe(n)
      server.close()
      server = undefined
    }
  })

  it('?mock-fail=<operationId> returns a documented 500 for that operation only', async () => {
    server = use(createMockDB('small'), readMockConfig('?mock-fail=listDevices'))
    const res = await send('GET', `${V1}/devices`)
    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({ error: { code: 'internal' } })
    expect(responseProblems('GET', `${V1}/devices`, 500, res.body)).toEqual([])
    expect((await send('GET', `${V1}/tags`)).status).toBe(200)
  })

  it('?mock-delay delays every response', async () => {
    server = use(createMockDB('small'), readMockConfig('?mock-delay=120'))
    const t0 = performance.now()
    await send('GET', `${V1}/tags`)
    expect(performance.now() - t0).toBeGreaterThanOrEqual(100)
  })

  it('an admin gets 403 forbidden on /users, PATCH /server and PUT /settings/dashboard', async () => {
    server = use(createMockDB('small'), readMockConfig('?mock-role=admin'))
    const me = (await send('GET', `${V1}/auth/me`)).body as {
      user: Schemas['User']
      csrf_token: string
    }
    expect(me.user.role).toBe('admin')
    const csrf = me.csrf_token
    for (const [m, p, body] of [
      ['GET', '/users', undefined],
      ['POST', '/users', { username: 'x', password: PASSWORD, role: 'admin' }],
      ['PATCH', '/server', { name: 'x' }],
      [
        'PUT',
        '/settings/dashboard',
        { offline_days: 7, pending_hours: 24, min_client_version: '' },
      ],
    ] as const) {
      const res = await send(m, V1 + p, { csrf, body })
      expect(res.status, `${m} ${p}`).toBe(403)
      expect(res.body).toMatchObject({ error: { code: 'forbidden' } })
    }
    expect((await send('GET', `${V1}/devices`)).status).toBe(200)
  })

  it('refuses a state change without the CSRF header', async () => {
    server = use(createMockDB('small'), readMockConfig(''))
    const res = await send('POST', `${V1}/tags`, { body: { name: 'x' } })
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ error: { code: 'csrf' } })
  })

  it('locks sign-in after 5 failures', async () => {
    server = use(createMockDB('small'), readMockConfig(''))
    const me = (await send('GET', `${V1}/auth/me`)).body as { csrf_token: string }
    await send('POST', `${V1}/auth/logout`, { csrf: me.csrf_token })
    for (let i = 0; i < 5; i++) {
      const bad = await send('POST', `${V1}/auth/login`, {
        body: { username: 'alex', password: 'wrong wrong wrong' },
      })
      expect(bad.status).toBe(i < 4 ? 401 : 423)
    }
    const locked = await send('POST', `${V1}/auth/login`, {
      body: { username: 'alex', password: PASSWORD },
    })
    expect(locked.status).toBe(423)
  })

  it('a fresh login is mfa-gated until the code is given', async () => {
    server = use(createMockDB('small'), readMockConfig(''))
    const me = (await send('GET', `${V1}/auth/me`)).body as { csrf_token: string }
    await send('POST', `${V1}/auth/logout`, { csrf: me.csrf_token })
    const login = (
      await send('POST', `${V1}/auth/login`, { body: { username: 'alex', password: PASSWORD } })
    ).body as { csrf_token: string }
    const gated = await send('GET', `${V1}/devices`)
    expect(gated.status).toBe(403)
    expect(gated.body).toMatchObject({ error: { code: 'mfa_required' } })
    const code = (
      await send('POST', `${V1}/auth/totp`, { csrf: login.csrf_token, body: { code: '123456' } })
    ).body as { csrf_token: string }
    expect(code.csrf_token).not.toBe(login.csrf_token)
    expect((await send('GET', `${V1}/devices`)).status).toBe(200)
  })
})

describe('mock state', () => {
  let db: MockDB
  let server: Server
  let csrf: string
  beforeEach(async () => {
    db = createMockDB('medium')
    server = use(db, readMockConfig(''))
    csrf = ((await send('GET', `${V1}/auth/me`)).body as Schemas['CSRFToken']).csrf_token
  })
  afterEach(() => server.close())

  const pendingDevices = async () =>
    (
      (await send('GET', `${V1}/devices?state=pending&limit=200`)).body as {
        items: Schemas['Device'][]
      }
    ).items
  const summary = async () =>
    (await send('GET', `${V1}/stats/summary`)).body as Schemas['FleetSummary']

  it('approving a device changes the list, the summary and the audit', async () => {
    const before = await summary()
    const pending = await pendingDevices()
    expect(pending.length).toBeGreaterThan(0)
    expect(pending).toHaveLength(before.devices.pending)
    const target = pending[0]!
    const auditBefore = (await send('GET', `${V1}/audit?limit=200`)).body as {
      items: Schemas['AuditEvent'][]
    }

    const res = await send('POST', `${V1}/devices/${target.id}/approve`, { csrf })
    expect(res.status).toBe(200)
    const approved = res.body as Schemas['Device']
    expect(approved.state).toBe('approved')
    expect(approved.approved_by).not.toBeNull()
    expect(approved.approved_at).not.toBeNull()

    const after = await summary()
    expect(after.devices.pending).toBe(before.devices.pending - 1)
    expect(after.devices.approved).toBe(before.devices.approved + 1)
    expect((await pendingDevices()).map((d) => d.id)).not.toContain(target.id)

    const auditAfter = (await send('GET', `${V1}/audit?limit=200`)).body as {
      items: Schemas['AuditEvent'][]
    }
    expect(auditAfter.items).toHaveLength(auditBefore.items.length + 1)
    expect(auditAfter.items[0]).toMatchObject({
      action: 'device.approved',
      target_type: 'device',
      target_id: target.id,
    })
  })

  it('serves fleet map with only approved devices', async () => {
    const res = await send('GET', `${V1}/stats/fleet-map`)
    expect(res.status).toBe(200)
    const body = res.body as Schemas['FleetMap']
    expect(body.truncated).toBe(false)
    expect(body.devices.every((d) => ['alert', 'offline', 'online'].includes(d.status))).toBe(true)
    expect(
      body.devices.every((d) => db.deviceRows.find((row) => row.id === d.id)?.state === 'approved'),
    ).toBe(true)
  })

  it('the summary agrees with the device list', async () => {
    const s = await summary()
    const all = (await send('GET', `${V1}/devices?limit=200`)).body as {
      items: Schemas['Device'][]
    }
    const count = (state: string) => all.items.filter((d) => d.state === state).length
    expect(s.devices).toEqual({
      approved: count('approved'),
      pending: count('pending'),
      rejected: count('rejected'),
      archived: count('archived'),
      online: all.items.filter((d) => d.state === 'approved' && d.online).length,
    })
    expect(s.alerts.open).toBe(all.items.reduce((n, d) => n + d.open_alerts.length, 0))
  })

  it('keeps 90 days of five-minute snapshots', async () => {
    const h = (await send('GET', `${V1}/stats/history?range=30d`)).body as Schemas['FleetHistory']
    expect(h.step_seconds).toBe(21600)
    expect(h.points.length).toBeGreaterThanOrEqual(119)
    expect(db.snapshotCount()).toBe(90 * 24 * 12)
  })

  it('emits a LiveEvent whenever the mock changes', async () => {
    const seen: Schemas['LiveEvent'][] = []
    const off = db.subscribe((e) => seen.push(e))
    const target = (await pendingDevices())[0]!
    await send('POST', `${V1}/devices/${target.id}/approve`, { csrf })
    off()
    expect(seen.map((e) => e.type)).toEqual(['device.updated', 'audit.created'])
    expect(seen[0]).toMatchObject({ device_id: target.id })
    for (const e of seen) expect(liveEventProblems(e)).toEqual([])
  })

  it('emits an ID allow list event when a list is saved', async () => {
    const seen: Schemas['LiveEvent'][] = []
    const off = db.subscribe((e) => seen.push(e))
    await send('PUT', `${V1}/settings/id-allow-list`, { csrf, body: { ids: ['Global_1'] } })
    off()
    expect(seen.map((e) => e.type)).toEqual(['audit.created', 'id_allow_list.updated'])
    for (const e of seen) expect(liveEventProblems(e)).toEqual([])
  })

  it('toggles a device online or offline and tells subscribers', () => {
    const seen: Schemas['LiveEvent'][] = []
    db.subscribe((e) => seen.push(e))
    db.toggleRandomDeviceOnline()
    expect(seen).toHaveLength(1)
    expect(['device.online', 'device.offline']).toContain(seen[0]!.type)
    expect(liveEventProblems(seen[0])).toEqual([])
  })

  it('streams LiveEvents from /events', async () => {
    const res = await raw('GET', `${V1}/events`, { accept: 'text/event-stream' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const target = (await pendingDevices())[0]!
    await send('POST', `${V1}/devices/${target.id}/approve`, { csrf })
    await vi.waitFor(async () => {
      const { value } = await reader.read()
      text += decoder.decode(value)
      expect(text).toMatch(/event: ?device\.updated/)
      expect(text).toMatch(/event: ?audit\.created/)
    })
    // cancel() on MSW's stream does not settle promptly in Node; the test does not wait on it.
    void reader.cancel()
    const datas = [...text.matchAll(/^data: ?(.*)$/gm)].map((m) => JSON.parse(m[1]!) as unknown)
    expect(datas.length).toBeGreaterThan(0)
    for (const d of datas) expect(liveEventProblems(d)).toEqual([])
  })
})
