import { afterEach, describe, expect, it } from 'vitest'
import { createMockDB } from './db'
import { fleetMap, summary } from './stats'

it('adds the custom preset to effective settings only for managed permissions', () => {
  const db = createMockDB('small')
  const owner = db.users.find((u) => u.role === 'owner')!
  const device = db.deviceRows.find((d) => d.state === 'approved')!
  const baseline = db.policies.find((p) => p.is_default)!
  db.updatePolicy(
    baseline.id,
    undefined,
    {
      'approve-mode': 'password-click',
      'verification-method': 'use-both-passwords',
      'enable-file-transfer': 'N',
    },
    owner,
  )
  expect(db.devicePolicyStatus(device.id)).toMatchObject({
    ok: true,
    value: { effective_settings: { 'enable-file-transfer': 'N', 'access-mode': 'custom' } },
  })
  db.updatePolicy(
    baseline.id,
    undefined,
    {
      'approve-mode': 'password-click',
      'verification-method': 'use-both-passwords',
    },
    owner,
  )
  const result = db.devicePolicyStatus(device.id)
  if (!result.ok) throw new Error('missing device')
  expect(result.value.effective_settings).not.toHaveProperty('access-mode')
})

it('fleet map sorts approved devices, masks ungranted groups, and reports its cap', () => {
  const db = createMockDB('small')
  const approved = db.deviceRows.filter((d) => d.state === 'approved').slice(0, 2)
  const fallback = {
    ...approved[0]!,
    id: '00000000-0000-4000-8000-000000000003',
    rustdesk_id: 'fallback',
    alias: '',
    hostname: '',
  }
  db.deviceRows.push(fallback)
  approved.push(fallback)
  approved[0]!.alias = 'zulu'
  approved[1]!.alias = 'Alpha'
  approved[2]!.alias = ''
  approved[2]!.hostname = ''
  approved[2]!.rustdesk_id = 'fallback'
  approved[0]!.group_id = db.groups[0]!.id
  db.online.add(approved[0]!.id)
  approved[0]!.open_alerts.push({
    id: 'alert',
    kind: 'uuid_mismatch',
    seen_uuid: 'different',
    window_closed_at: null,
    created_at: new Date(db.now()).toISOString(),
    ip: null,
    groups: [],
  })
  const visible = new Set(approved.map((d) => d.id))
  const groupVisible = new Set<string>()
  const result = fleetMap(db, { devices: visible, groups: groupVisible }, 2)
  expect(result.truncated).toBe(true)
  expect(result.devices).toHaveLength(2)
  expect(result.devices.map((d) => d.name)).toEqual(['Alpha', 'fallback'])
  const alert = fleetMap(db, { devices: visible, groups: groupVisible }, 10).devices.find(
    (d) => d.id === approved[0]!.id,
  )!
  expect(alert.status).toBe('alert')
  expect(alert.group_id).toBeNull()
})

it('expires mock access windows on the clock and resolves unconfirmed alerts', () => {
  let now = Date.UTC(2026, 9, 17, 12)
  const db = createMockDB('small', { clock: () => now })
  const owner = db.users.find((u) => u.role === 'owner')!
  const device = db.deviceRows.find((d) => d.state === 'approved')!
  const baseline = db.policies.find((p) => p.is_default)!
  db.updatePolicy(
    baseline.id,
    undefined,
    { 'approve-mode': 'click', 'verification-method': 'use-both-passwords' },
    owner,
  )
  db.setPolicyPush(true, owner)
  const opened = db.openAccessWindow(device.id, 60, true, owner)
  expect(opened.ok).toBe(true)
  now += 60 * 60_000 - 1
  expect(db.devicePolicyStatus(device.id)).toMatchObject({
    ok: true,
    value: { status: 'pending', window: { id: opened.ok ? opened.value.id : '' } },
  })
  now += 1
  expect(db.devicePolicyStatus(device.id)).toMatchObject({ ok: true, value: { window: null } })
  expect(db.auditLog.find((a) => a.action === 'access_window.closed')?.actor_user_id).toBeNull()
  now += 5 * 60_000 - 1
  db.sweepAccessWindows()
  expect(device.open_alerts.some((a) => a.kind === 'access_window_unconfirmed')).toBe(false)
  now += 1
  db.sweepAccessWindows()
  expect(device.open_alerts.find((a) => a.kind === 'access_window_unconfirmed')).toMatchObject({
    seen_uuid: null,
    ip: null,
  })
  expect(summary(db).attention.some((a) => a.kind === 'access_window_unconfirmed')).toBe(true)
  db.setDeviceVersionSeen(device.id, true)
  expect(db.devicePolicyStatus(device.id)).toMatchObject({
    ok: true,
    value: { status: 'applied', close_unconfirmed_since: null },
  })
  expect(device.open_alerts.some((a) => a.kind === 'access_window_unconfirmed')).toBe(false)
  db.setDeviceVersionSeen(device.id, false)
  db.sweepAccessWindows()
  db.setPolicyPush(false, owner)
  db.sweepAccessWindows()
  expect(db.devicePolicyStatus(device.id)).toMatchObject({ ok: true, value: { status: 'off' } })
  expect(device.open_alerts.some((a) => a.kind === 'access_window_unconfirmed')).toBe(false)
})

// Preferences outlive a reload only in the browser, where startMockWorker
// passes sessionStorage. Tests build a MockDB per case and must not see
// each other's layouts through jsdom's shared storage.
describe('mock preferences storage', () => {
  afterEach(() => sessionStorage.clear())

  function userId(db: ReturnType<typeof createMockDB>) {
    const user = db.users[0]
    if (!user) throw new Error('no mock user')
    return user.id
  }

  it('does not use browser storage unless it is given a store', () => {
    const first = createMockDB('small')
    const id = userId(first)
    first.savePreferences(id, { ...first.preferencesFor(id), preset: 'custom' })

    expect(sessionStorage.length).toBe(0)
    expect(createMockDB('small').preferencesFor(id).preset).toBe('business')
  })

  it('keeps preferences across instances that share a store (a reload)', () => {
    const first = createMockDB('small', { preferencesStore: sessionStorage })
    const id = userId(first)
    first.savePreferences(id, { ...first.preferencesFor(id), preset: 'homelab' })

    const reloaded = createMockDB('small', { preferencesStore: sessionStorage })
    expect(reloaded.preferencesFor(id).preset).toBe('homelab')
  })

  it('ignores a store that throws or holds junk', () => {
    const broken = {
      getItem: () => '{not json',
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError')
      },
    }
    const db = createMockDB('small', { preferencesStore: broken })
    const id = userId(db)
    expect(db.preferencesFor(id).preset).toBe('business')
    expect(() => db.savePreferences(id, db.preferencesFor(id))).not.toThrow()
  })

  it('defaults missing or unknown palettes from older browser storage', () => {
    const id = 'admin'
    for (const stored of [
      { ...createMockDB('small').preferencesFor(id), palette: undefined },
      { ...createMockDB('small').preferencesFor(id), palette: 'neon' },
    ]) {
      const store = { getItem: () => JSON.stringify(stored), setItem: () => {} }
      expect(createMockDB('small', { preferencesStore: store }).preferencesFor(id).palette).toBe(
        'default',
      )
    }
  })

  it('defaults missing or invalid notification durations from older browser storage', () => {
    const id = 'admin'
    for (const toast_seconds of [undefined, 7]) {
      const stored = { ...createMockDB('small').preferencesFor(id), toast_seconds }
      const store = { getItem: () => JSON.stringify(stored), setItem: () => {} }
      expect(
        createMockDB('small', { preferencesStore: store }).preferencesFor(id).toast_seconds,
      ).toBe(5)
    }
  })
})

it('keeps saved session settings when the browser mock database is recreated', () => {
  const values = new Map<string, string>()
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
  const first = createMockDB('small', { sessionSettingsStore: store })
  const owner = first.users.find((user) => user.role === 'owner')!
  first.setSessionSettings('7d', owner)

  const afterReload = createMockDB('small', { sessionSettingsStore: store })
  expect(afterReload.sessionSettings).toMatchObject({
    lifetime: '7d',
    updated_by: { id: owner.id, display_name: owner.display_name },
  })
})

it('seeds mock ID allow lists with both an enrolled device ID and an unenrolled ID', () => {
  const db = createMockDB('small')
  const enrolledIds = new Set(db.deviceRows.map((d) => d.rustdesk_id.toLowerCase()))
  expect(db.globalIdAllowList.some((id) => enrolledIds.has(id.toLowerCase()))).toBe(true)
  expect(db.globalIdAllowList.some((id) => !enrolledIds.has(id.toLowerCase()))).toBe(true)
})
