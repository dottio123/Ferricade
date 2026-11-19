// The mock as the User role sees it, against what the server does for a User
// (internal/adminapi/roles_test.go, openapi.yaml "Authorization, by role").
import { afterEach, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { readMockConfig } from './config'
import { contractOperations, responseProblems } from './contract'
import { createMockControls } from './controls'
import { createMockDB } from './db'
import { createMockApi } from './handlers'
import { HELPDESK_ID } from './fixtures/users'
import type { Device, Group } from './fixtures/types'

const V1 = '/admin/api/v1'
const UNKNOWN = '3c9d1f7a-5b2e-4d8a-8f61-0a1b2c3d4e5f'

let stop: () => void = () => {}
afterEach(() => stop())

async function start(query = '?mock-role=user', size: 'small' | 'medium' = 'medium') {
  const db = createMockDB(size)
  const { handlers, env } = createMockApi(db, readMockConfig(query))
  const server = setupServer(...handlers)
  server.listen({ onUnhandledRequest: 'error' })
  stop = () => server.close()
  const controls = createMockControls(env)
  const me = await fetch(new Request(`${V1}/auth/me`))
  const csrf = ((await me.json()) as { csrf_token: string }).csrf_token
  async function call(method: string, path: string, body?: unknown) {
    const headers = new Headers({ 'X-CSRF-Token': csrf })
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    const res = await fetch(
      new Request(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
    const text = await res.text()
    return { status: res.status, body: text ? (JSON.parse(text) as unknown) : undefined }
  }
  return { db, env, controls, call }
}

type Outcome = 'own' | 'notFoundForUngranted' | 'scoped' | 'forbidden'
const TABLE: Record<Outcome, string> = {
  own: `
POST /admin/api/v1/auth/login
GET /admin/api/v1/auth/oidc
GET /admin/api/v1/auth/oidc/start
GET /admin/api/v1/auth/oidc/callback
POST /admin/api/v1/auth/logout
GET /admin/api/v1/auth/me
POST /admin/api/v1/auth/totp
POST /admin/api/v1/auth/totp/enroll
POST /admin/api/v1/auth/totp/enroll/verify
POST /admin/api/v1/auth/password
GET /admin/api/v1/users/{id}/avatar
GET /admin/api/v1/events
GET /admin/api/v1/me/preferences
PUT /admin/api/v1/me/preferences
GET /admin/api/v1/settings/dashboard
GET /setup/status
POST /setup/owner
POST /setup/owner/totp
POST /setup/owner/totp/verify
POST /setup/server
POST /setup/complete`,
  notFoundForUngranted: `
GET /admin/api/v1/devices/{id}
GET /admin/api/v1/devices/{id}/policy
GET /admin/api/v1/devices/{id}/connect`,
  scoped: `
GET /admin/api/v1/devices
GET /admin/api/v1/sessions
GET /admin/api/v1/sessions/stats
GET /admin/api/v1/audit
GET /admin/api/v1/stats/summary
GET /admin/api/v1/stats/fleet-map
GET /admin/api/v1/server/health
GET /admin/api/v1/dashboard/catalog
GET /admin/api/v1/groups
GET /admin/api/v1/tags`,
  forbidden: `
GET /admin/api/v1/group-rules
GET /admin/api/v1/settings/id-allow-list
PUT /admin/api/v1/settings/id-allow-list
GET /admin/api/v1/groups/{id}/id-allow-list
PUT /admin/api/v1/groups/{id}/id-allow-list
GET /admin/api/v1/devices/{id}/id-allow-list
PUT /admin/api/v1/devices/{id}/id-allow-list
POST /admin/api/v1/devices/auto-sort/preview
POST /admin/api/v1/devices/auto-sort
POST /admin/api/v1/groups/{id}/rules
DELETE /admin/api/v1/groups/{id}/rules/{rule_id}
POST /admin/api/v1/groups/{id}/rules/preview
GET /admin/api/v1/policies
POST /admin/api/v1/policies
GET /admin/api/v1/policies/{id}
PATCH /admin/api/v1/policies/{id}
DELETE /admin/api/v1/policies/{id}
GET /admin/api/v1/settings/policy-push
PUT /admin/api/v1/settings/policy-push
GET /admin/api/v1/settings/sessions
PUT /admin/api/v1/settings/sessions
GET /admin/api/v1/settings/log-export
PUT /admin/api/v1/settings/log-export
POST /admin/api/v1/settings/log-export/test
PUT /admin/api/v1/groups/{id}/policy
GET /admin/api/v1/settings/oidc
PATCH /admin/api/v1/settings/oidc
POST /admin/api/v1/settings/oidc/test
GET /admin/api/v1/server/client-config
GET /admin/api/v1/deployment/profile
PUT /admin/api/v1/deployment/profile
POST /admin/api/v1/deployment/script
POST /admin/api/v1/sessions/{id}/disconnect
GET /admin/api/v1/server
PATCH /admin/api/v1/server
POST /admin/api/v1/server/check
GET /admin/api/v1/stats/history
PUT /admin/api/v1/settings/dashboard
PATCH /admin/api/v1/devices/{id}
DELETE /admin/api/v1/devices/{id}
POST /admin/api/v1/devices/{id}/approve
POST /admin/api/v1/devices/{id}/reject
POST /admin/api/v1/devices/{id}/reopen
POST /admin/api/v1/devices/{id}/archive
POST /admin/api/v1/devices/{id}/restore
POST /admin/api/v1/devices/{id}/alerts/{alert_id}/resolve
POST /admin/api/v1/devices/{id}/access-window
POST /admin/api/v1/devices/{id}/access-window/close
POST /admin/api/v1/groups
PATCH /admin/api/v1/groups/{id}
POST /admin/api/v1/groups/{id}/move
DELETE /admin/api/v1/groups/{id}
POST /admin/api/v1/tags
PATCH /admin/api/v1/tags/{id}
DELETE /admin/api/v1/tags/{id}
GET /admin/api/v1/users
POST /admin/api/v1/users
PATCH /admin/api/v1/users/{id}
POST /admin/api/v1/users/{id}/reset-totp
POST /admin/api/v1/users/{id}/password
DELETE /admin/api/v1/users/{id}/oidc
GET /admin/api/v1/users/{id}/grants
PUT /admin/api/v1/users/{id}/grants`,
}

function tableOf(): Map<string, Outcome> {
  const outcomes = new Map<string, Outcome>()
  for (const [outcome, lines] of Object.entries(TABLE)) {
    for (const line of lines.trim().split('\n')) {
      const [method, path] = line.split(' ')
      const key = `${method} ${path}`
      expect(outcomes.has(key), `duplicate: ${key}`).toBe(false)
      outcomes.set(key, outcome as Outcome)
    }
  }
  return outcomes
}

const errorCode = (body: unknown) => (body as { error: { code: string } }).error.code

describe('?mock-role=user', () => {
  it('signs in as the helpdesk account', async () => {
    const { call } = await start()
    const me = await call('GET', `${V1}/auth/me`)
    expect(me.body).toMatchObject({ user: { id: HELPDESK_ID, role: 'user' } })
  })

  it('every operation of the contract has an outcome in the table, and the mock gives it', async () => {
    const outcomes = tableOf()
    const operations = contractOperations()
    for (const op of operations) expect(outcomes.has(op), `${op} has no User outcome`).toBe(true)
    for (const key of outcomes.keys())
      expect(operations, `${key} is not an operation`).toContain(key)

    const { call } = await start()
    for (const [key, outcome] of outcomes) {
      if (key === 'POST /admin/api/v1/auth/logout' || key === 'GET /admin/api/v1/events') continue
      if (key.includes('/oidc/start') || key.includes('/oidc/callback')) continue
      const [method, template] = key.split(' ') as [string, string]
      const path = template.replace('{id}', UNKNOWN).replace('{alert_id}', UNKNOWN)
      const res = await call(method, path)
      const label = `${key} -> ${res.status} ${JSON.stringify(res.body)}`
      switch (outcome) {
        case 'forbidden':
          expect(res.status, label).toBe(403)
          expect(res.body, label).toEqual({
            error: { code: 'forbidden', message: 'not allowed for your role' },
          })
          break
        case 'notFoundForUngranted':
          expect(res.status, label).toBe(404)
          expect(errorCode(res.body), label).toBe('not_found')
          break
        case 'scoped':
          expect(res.status, label).toBe(200)
          expect(responseProblems(method, template, res.status, res.body), label).toEqual([])
          break
        case 'own':
          if (res.status === 403) expect(errorCode(res.body), label).not.toBe('forbidden')
          break
      }
    }
    expect((await call('POST', `${V1}/auth/logout`)).status).toBe(204)
  })
})

it('allows an Admin to read policy push but reserves updates for the Owner', async () => {
  const { call } = await start('?mock-role=admin')
  expect((await call('GET', `${V1}/settings/policy-push`)).status).toBe(200)
  const response = await call('PUT', `${V1}/settings/policy-push`, { enabled: true })
  expect(response.status).toBe(403)
  expect(errorCode(response.body)).toBe('forbidden')
})

it('guards a granted User connect link when the policy is locked', async () => {
  const { db, call } = await start()
  const device = db.deviceRows.find(
    (d) => d.state === 'approved' && db.visibleDeviceIds(HELPDESK_ID).has(d.id),
  )!
  const owner = db.users.find((u) => u.role === 'owner')!
  const policy = db.policies.find((p) => p.is_default)!
  db.policyPush.enabled = true
  db.updatePolicy(
    policy.id,
    undefined,
    { 'approve-mode': 'password', 'verification-method': 'use-temporary-password' },
    owner,
  )
  const path = `${V1}/devices/${device.id}`
  expect((await call('GET', `${path}/policy`)).body).toMatchObject({ connect: 'locked' })
  const before = db.auditLog.filter((e) => e.action === 'device.connect_link').length
  expect(await call('GET', `${path}/connect`)).toMatchObject({
    status: 409,
    body: { error: { code: 'access_locked' } },
  })
  expect(db.auditLog.filter((e) => e.action === 'device.connect_link')).toHaveLength(before)
  db.updatePolicy(
    policy.id,
    undefined,
    { 'approve-mode': 'click', 'verification-method': 'use-both-passwords' },
    owner,
  )
  expect((await call('GET', `${path}/policy`)).body).toMatchObject({ connect: 'attended' })
  expect((await call('GET', `${path}/connect`)).status).toBe(200)
})

describe('what a User sees', () => {
  it('scopes device policy status and forbids access-window writes', async () => {
    const { db, call } = await start()
    const visible = db.deviceRows.find((d) => db.visibleDeviceIds(HELPDESK_ID).has(d.id))!
    const hidden = db.deviceRows.find(
      (d) => d.state === 'approved' && !db.visibleDeviceIds(HELPDESK_ID).has(d.id),
    )!
    const owner = db.users.find((u) => u.role === 'owner')!
    const privateGroup = db.groups[0]!
    const privatePolicy = db.policies.find((p) => p.is_default)!
    privatePolicy.settings = {
      'approve-mode': 'click',
      'verification-method': 'use-both-passwords',
    }
    privateGroup.policy_id = privatePolicy.id
    visible.group_id = privateGroup.id
    db.grants.set(HELPDESK_ID, { group_ids: [], device_ids: [visible.id] })
    db.policyPush.enabled = true
    expect(db.openAccessWindow(visible.id, null, false, owner).ok).toBe(true)
    const shown = await call('GET', `${V1}/devices/${visible.id}/policy`)
    expect(shown.status).toBe(200)
    expect(shown.body).toMatchObject({ source_group: null, window: { opened_by: null } })
    expect(responseProblems('GET', `${V1}/devices/{id}/policy`, shown.status, shown.body)).toEqual(
      [],
    )
    expect((await call('GET', `${V1}/devices/${hidden.id}/policy`)).status).toBe(404)
    expect(
      await call('POST', `${V1}/devices/${visible.id}/access-window`, {
        duration_minutes: null,
        disconnect_on_close: false,
      }),
    ).toMatchObject({ status: 403 })
    expect(
      await call('POST', `${V1}/devices/${visible.id}/access-window/close`, { disconnect: false }),
    ).toMatchObject({ status: 403 })
  })
  it('visibleDeviceIds: approved, granted directly or by a group or its descendants', async () => {
    const { db } = await start()
    const owner = db.users.find((u) => u.role === 'owner')!
    const granted = db.grantsFor(HELPDESK_ID)
    const parent = granted.group_ids[0]!
    const child = db.createGroup('Sub', parent, owner)
    const grandchild = db.createGroup('Subsub', child.ok ? child.value.id : '', owner)
    if (!child.ok || !grandchild.ok) throw new Error('groups')
    const approved = db.deviceRows.filter((d) => d.state === 'approved')
    const other = approved.find((d) => !granted.device_ids.includes(d.id) && d.group_id !== parent)!
    db.patchDevice(other.id, { group_id: grandchild.value.id }, owner)
    const pending = db.deviceRows.find((d) => d.state === 'pending')!
    db.patchDevice(pending.id, { group_id: parent }, owner)

    const visible = db.visibleDeviceIds(HELPDESK_ID)
    expect(visible.has(other.id)).toBe(true)
    expect(visible.has(pending.id)).toBe(false)
    for (const id of visible) expect(db.device(id)?.state).toBe('approved')
    for (const id of granted.device_ids) expect(visible.has(id)).toBe(true)
    const groups = db.visibleGroupIds(HELPDESK_ID)
    for (const id of [parent, child.value.id, grandchild.value.id])
      expect(groups.has(id)).toBe(true)
    for (const g of db.groups) {
      // Visible exactly when the group or an ancestor is the granted one.
      const chain: string[] = []
      for (let at: string | null = g.id; at;) {
        chain.push(at)
        at = db.groups.find((x) => x.id === at)?.parent_id ?? null
      }
      expect(groups.has(g.id), g.name).toBe(chain.some((id) => granted.group_ids.includes(id)))
    }
  })

  it('devices: visible only, approved_by null, other states empty, others 404 like unknown', async () => {
    const { db, call } = await start()
    const visible = db.visibleDeviceIds(HELPDESK_ID)
    expect(visible.size).toBeGreaterThan(0)
    const list = await call('GET', `${V1}/devices?limit=200`)
    const items = (list.body as { items: Device[] }).items
    expect(new Set(items.map((d) => d.id))).toEqual(visible)
    for (const d of items) expect(d.approved_by).toBeNull()
    for (const state of ['pending', 'rejected', 'archived']) {
      const r = await call('GET', `${V1}/devices?state=${state}`)
      expect((r.body as { items: unknown[] }).items).toEqual([])
    }
    const one = await call('GET', `${V1}/devices/${items[0]!.id}`)
    expect(one.status).toBe(200)
    expect((one.body as Device).approved_by).toBeNull()

    const hidden = db.deviceRows.find((d) => !visible.has(d.id))!
    const unknown = await call('GET', `${V1}/devices/${UNKNOWN}`)
    const outside = await call('GET', `${V1}/devices/${hidden.id}`)
    expect(outside.status).toBe(404)
    expect(outside.body).toEqual(unknown.body)
    const link = await call('GET', `${V1}/devices/${hidden.id}/connect`)
    expect(link.status).toBe(404)
    expect(link.body).toEqual(unknown.body)
    expect((await call('GET', `${V1}/devices/${items[0]!.id}/connect`)).status).toBe(200)
  })

  it('sessions and their statistics: visible devices only', async () => {
    const { db, call } = await start()
    const visible = db.visibleDeviceIds(HELPDESK_ID)
    expect(db.sessionRows.some((s) => !visible.has(s.device_id))).toBe(true)
    const list = await call('GET', `${V1}/sessions?limit=200`)
    const rows = (list.body as { items: { device_id: string }[] }).items
    for (const s of rows) expect(visible.has(s.device_id)).toBe(true)
    const stats = (await call('GET', `${V1}/sessions/stats?range=30d`)).body as {
      per_day: { count: number }[]
      top_devices: { device_id: string }[]
    }
    for (const t of stats.top_devices) expect(visible.has(t.device_id)).toBe(true)
    const expected = db.sessionRows.filter(
      (s) => visible.has(s.device_id) && s.authed_at !== null,
    ).length
    const counted = stats.per_day.reduce((n, d) => n + d.count, 0)
    expect(counted).toBeLessThanOrEqual(expected)
  })

  it('audit: only their own entries, the actor parameter ignored', async () => {
    const { db, call } = await start()
    db.record(db.findUser(HELPDESK_ID)!, 'device.connect_link', 'device', UNKNOWN, {})
    const owner = db.users.find((u) => u.role === 'owner')!
    const res = await call('GET', `${V1}/audit?limit=200&actor=${owner.id}`)
    const items = (res.body as { items: { actor_user_id: string }[] }).items
    expect(items.length).toBeGreaterThan(0)
    for (const e of items) expect(e.actor_user_id).toBe(HELPDESK_ID)
  })

  it('groups: granted groups are roots, a granted group under a granted one is not', async () => {
    const { db, call } = await start()
    const owner = db.users.find((u) => u.role === 'owner')!
    const granted = db.grantsFor(HELPDESK_ID)
    const parent = granted.group_ids[0]!
    const child = db.createGroup('Granted child', parent, owner)
    if (!child.ok) throw new Error('group')
    db.replaceGrants(
      HELPDESK_ID,
      { group_ids: [parent, child.value.id], device_ids: granted.device_ids },
      owner,
    )
    const res = await call('GET', `${V1}/groups`)
    const roots = (res.body as { items: Group[] }).items
    expect(roots.map((g) => g.id)).toEqual([parent])
    expect(roots[0]!.children.map((g) => g.id)).toContain(child.value.id)
  })

  it('tags: only those on a visible device', async () => {
    const { db, call } = await start()
    const visible = db.visibleDeviceIds(HELPDESK_ID)
    const expected = new Set(
      db.deviceRows.filter((d) => visible.has(d.id)).flatMap((d) => d.tag_ids),
    )
    expect(expected.size).toBeLessThan(db.tags.length)
    const res = await call('GET', `${V1}/tags?limit=200`)
    const ids = (res.body as { items: { id: string }[] }).items.map((t) => t.id)
    expect(new Set(ids)).toEqual(expected)
  })

  it('summary: counts visible devices, pending is 0', async () => {
    const { db, call } = await start()
    const visible = db.visibleDeviceIds(HELPDESK_ID)
    const res = await call('GET', `${V1}/stats/summary`)
    const devices = (res.body as { devices: Record<string, number> }).devices
    expect(devices).toMatchObject({ approved: visible.size, pending: 0, rejected: 0, archived: 0 })
    expect(devices.online).toBe([...visible].filter((id) => db.online.has(id)).length)
  })

  it('fleet map: hides invisible devices and masks individually granted hidden groups', async () => {
    const { db, call } = await start()
    const visible = db.visibleDeviceIds(HELPDESK_ID)
    const result = await call('GET', `${V1}/stats/fleet-map`)
    expect(result.status).toBe(200)
    const devices = (result.body as { devices: { id: string; group_id: string | null }[] }).devices
    expect(devices.every((d) => visible.has(d.id))).toBe(true)
    const individuallyGranted = db.deviceRows.find(
      (d) =>
        visible.has(d.id) &&
        d.group_id !== null &&
        !db.visibleGroupIds(HELPDESK_ID).has(d.group_id),
    )
    if (individuallyGranted) {
      expect(devices.find((d) => d.id === individuallyGranted.id)?.group_id).toBeNull()
    }
  })

  it('server health: lets a User read checks with all details blank', async () => {
    const { call, controls } = await start()
    controls.setServerCheck('relay', false, 'sensitive relay error')
    const res = await call('GET', `${V1}/server/health`)
    expect(res.status).toBe(200)
    expect(
      (res.body as { checks: { detail: string }[] }).checks.every((check) => check.detail === ''),
    ).toBe(true)
  })

  it('catalog: eight modules, no wall preset, presets cut to them', async () => {
    const { call } = await start()
    const res = await call('GET', `${V1}/dashboard/catalog`)
    const catalog = res.body as {
      modules: { id: string }[]
      presets: { id: string; modules: { id: string }[] }[]
    }
    const ids = catalog.modules.map((m) => m.id)
    expect(ids.toSorted()).toEqual(
      [
        'fleet-pulse',
        'quick-connect',
        'needs-attention',
        'live-sessions',
        'fleet-overview',
        'recent-sessions',
        'session-analytics',
        'platform-mix',
      ].toSorted(),
    )
    expect(catalog.presets.map((p) => p.id)).not.toContain('wall')
    expect(catalog.presets.length).toBeGreaterThan(0)
    for (const p of catalog.presets) {
      expect(p.modules.length).toBeGreaterThan(0)
      for (const m of p.modules) expect(ids).toContain(m.id)
    }
  })

  it('avatar: any id but their own is 404', async () => {
    const { call } = await start()
    expect((await call('GET', `${V1}/users/${UNKNOWN}/avatar`)).status).toBe(404)
  })
})

describe('what a User must not learn (t50)', () => {
  const prefs = (pins: string[]) => ({
    preset: 'custom',
    modules: [],
    pinned_device_ids: pins,
    theme: 'system',
    density: 'comfortable',
  })

  it('pins: kept only for visible devices', async () => {
    const { db, call } = await start()
    const visible = db.visibleDeviceIds(HELPDESK_ID)
    const seen = [...visible][0]!
    const hidden = db.deviceRows.find((d) => d.state === 'approved' && !visible.has(d.id))!
    const put = await call('PUT', `${V1}/me/preferences`, prefs([hidden.id, UNKNOWN, seen]))
    expect(put.status).toBe(200)
    expect((put.body as { pinned_device_ids: string[] }).pinned_device_ids).toEqual([seen])
    const got = await call('GET', `${V1}/me/preferences`)
    expect((got.body as { pinned_device_ids: string[] }).pinned_device_ids).toEqual([seen])
  })

  it('audit: only auth.* and device.connect_link entries', async () => {
    const { db, call } = await start()
    const me = db.findUser(HELPDESK_ID)!
    db.record(me, 'device.approved', 'device', UNKNOWN, {})
    db.record(me, 'user.created', 'user', UNKNOWN, {})
    db.record(me, 'device.connect_link', 'device', UNKNOWN, {})
    const res = await call('GET', `${V1}/audit?limit=200`)
    const actions = (res.body as { items: { action: string }[] }).items.map((e) => e.action)
    expect(actions).toContain('device.connect_link')
    for (const a of actions)
      expect(a.startsWith('auth.') || a === 'device.connect_link', a).toBe(true)
    const direct = await call('GET', `${V1}/audit?action=device.approved`)
    expect((direct.body as { items: unknown[] }).items).toEqual([])
  })

  it('group_id: null for a group outside the grants (list and detail)', async () => {
    const { db, call } = await start()
    const owner = db.users.find((u) => u.role === 'owner')!
    const visibleGroups = db.visibleGroupIds(HELPDESK_ID)
    const outside = db.groups.find((g) => !visibleGroups.has(g.id))!
    const target = db.deviceRows.find(
      (d) => d.state === 'approved' && db.visibleDeviceIds(HELPDESK_ID).has(d.id),
    )!
    db.grantsFor(HELPDESK_ID).device_ids.push(target.id)
    db.patchDevice(target.id, { group_id: outside.id }, owner)
    expect(db.device(target.id)?.group_id).toBe(outside.id)
    // Now visible only through the direct grant.
    const detail = await call('GET', `${V1}/devices/${target.id}`)
    expect((detail.body as Device).group_id).toBeNull()
    const list = await call('GET', `${V1}/devices?limit=200`)
    const row = (list.body as { items: Device[] }).items.find((d) => d.id === target.id)!
    expect(row.group_id).toBeNull()
    // A visible group still shows.
    const inside = db.deviceRows.find((d) => d.group_id !== null && visibleGroups.has(d.group_id))
    if (inside) {
      const d = await call('GET', `${V1}/devices/${inside.id}`)
      expect((d.body as Device).group_id).toBe(inside.group_id)
    }
  })

  it('client_ip is null and alert ip is empty', async () => {
    const { db, call } = await start()
    const visible = db.visibleDeviceIds(HELPDESK_ID)
    const device = db.deviceRows.find((d) => visible.has(d.id))!
    device.open_alerts = [
      {
        id: UNKNOWN,
        kind: 'uuid_mismatch',
        seen_uuid: 'bmV3',
        window_closed_at: null,
        groups: [],
        ip: '203.0.113.9',
        created_at: '2026-10-01T00:00:00Z',
      },
    ]
    const session = db.sessionRows.find((s) => visible.has(s.device_id))!
    session.client_ip = '198.51.100.7'
    const sessions = await call('GET', `${V1}/sessions?limit=200`)
    const items = (sessions.body as { items: { client_ip: string | null }[] }).items
    expect(items.length).toBeGreaterThan(0)
    for (const s of items) expect(s.client_ip).toBeNull()
    const detail = (await call('GET', `${V1}/devices/${device.id}`)).body as Device
    expect(detail.open_alerts.map((a) => a.ip)).toEqual([''])
    const list = (await call('GET', `${V1}/devices?limit=200`)).body as { items: Device[] }
    expect(list.items.find((d) => d.id === device.id)!.open_alerts.map((a) => a.ip)).toEqual([''])
  })
})

describe('?mock-grants=none', () => {
  it('leaves the User with nothing visible and no 403 on an allow-listed operation', async () => {
    const { db, call } = await start('?mock-role=user&mock-grants=none')
    expect(db.grantsFor(HELPDESK_ID)).toEqual({ group_ids: [], device_ids: [] })
    expect(db.visibleDeviceIds(HELPDESK_ID).size).toBe(0)
    for (const path of [
      'devices',
      'sessions',
      'sessions/stats',
      'audit',
      'stats/summary',
      'dashboard/catalog',
      'groups',
      'tags',
      'settings/dashboard',
      'me/preferences',
    ]) {
      const res = await call('GET', `${V1}/${path}`)
      expect(res.status, path).toBe(200)
    }
    const devices = await call('GET', `${V1}/devices`)
    expect((devices.body as { items: unknown[] }).items).toEqual([])
  })

  it('does nothing without mock-role=user', () => {
    expect(readMockConfig('?mock-grants=none').role).toBe('owner')
  })
})

describe('live events for a User', () => {
  async function open() {
    const res = await fetch(
      new Request(`${V1}/events`, { headers: { Accept: 'text/event-stream' } }),
    )
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let ended = false
    // One read stays pending between calls, so a chunk that lands after a quiet spell is not lost.
    let pending: ReturnType<typeof reader.read> | null = null
    /** What arrived since the last call, once the stream has been quiet for a moment. */
    async function drain(): Promise<string> {
      let text = ''
      for (;;) {
        pending ??= reader.read()
        const next = await Promise.race([
          pending,
          new Promise<'quiet'>((r) => setTimeout(() => r('quiet'), 60)),
        ])
        if (next === 'quiet') return text
        pending = null
        if (next.done) {
          ended = true
          return text
        }
        text += decoder.decode(next.value)
      }
    }
    await drain() // retry: 3000
    return { drain, ended: () => ended }
  }

  it('carries only visible devices and their own audit entries, never device.enrolled', async () => {
    const { db } = await start()
    const stream = await open()
    const visible = [...db.visibleDeviceIds(HELPDESK_ID)][0]!
    const hidden = db.deviceRows.find((d) => !db.visibleDeviceIds(HELPDESK_ID).has(d.id))!.id
    const owner = db.users.find((u) => u.role === 'owner')!

    db.emit({ type: 'device.updated', device_id: hidden })
    db.emit({ type: 'device.enrolled', device_id: visible })
    db.emit({ type: 'session.started', session_id: UNKNOWN, device_id: hidden })
    db.emit({ type: 'device.online', device_id: visible })
    db.emit({ type: 'session.ended', session_id: UNKNOWN, device_id: visible })
    db.record(owner, 'tag.created', 'tag', UNKNOWN, {})
    db.record(db.findUser(HELPDESK_ID)!, 'device.connect_link', 'device', visible, {})
    db.emit({ type: 'preferences.updated', user_id: HELPDESK_ID })
    const text = await stream.drain()

    expect(text).not.toContain(hidden)
    expect(text).not.toContain('device.enrolled')
    expect(text).toContain('event: device.online')
    expect(text).toContain('event: session.ended')
    expect(text).toContain('event: preferences.updated')
    expect(text.match(/event: audit\.created/g)).toHaveLength(1)
    expect(stream.ended()).toBe(false)
  })

  it('moveDevice takes a device out of the grants: resync, then the stream ends', async () => {
    const { db, controls } = await start()
    const granted = db.grantsFor(HELPDESK_ID)
    const owner = db.users.find((u) => u.role === 'owner')!
    const row = db.deviceRows.find(
      (d) => d.state === 'approved' && !granted.device_ids.includes(d.id),
    )!
    db.patchDevice(row.id, { group_id: granted.group_ids[0]! }, owner)
    expect(db.visibleDeviceIds(HELPDESK_ID).has(row.id)).toBe(true)

    const stream = await open()
    const before = db.auditLog.length
    controls.moveDevice(row.id, null)
    expect(db.device(row.id)!.group_id).toBeNull()
    expect(db.auditLog.length).toBe(before + 1)
    expect(db.auditLog[0]!.action).toBe('device.updated')

    const text = await stream.drain()
    expect(text).toContain('event: resync')
    expect(text).not.toContain(row.id)
    expect(stream.ended()).toBe(true)
  })

  it('replacing the grants also resyncs', async () => {
    const { db } = await start()
    const owner = db.users.find((u) => u.role === 'owner')!
    const stream = await open()
    const granted = db.grantsFor(HELPDESK_ID)
    db.replaceGrants(HELPDESK_ID, { group_ids: [], device_ids: granted.device_ids }, owner)
    const text = await stream.drain()
    expect(text).toContain('event: resync')
    expect(stream.ended()).toBe(true)
  })

  it('an owner stream is unfiltered and never resyncs for visibility', async () => {
    const { db } = await start('')
    const stream = await open()
    db.emit({ type: 'device.enrolled', device_id: UNKNOWN })
    const text = await stream.drain()
    expect(text).toContain('event: device.enrolled')
    expect(stream.ended()).toBe(false)
  })
})
