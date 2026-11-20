import { expect, it } from 'vitest'
import { createMockDB } from './db'
import { matchHostname, validPattern } from './groupRules'
import { summary } from './stats'

it('auto sorts only approved devices, previews without writes, and keeps alerts consistent', () => {
  const db = createMockDB('medium')
  const owner = db.users.find((u) => u.role === 'owner')!
  const [a, b] = db.groups
  db.groupRules = []
  db.addGroupRule(a!.id, 'pc-*', owner)
  db.addGroupRule(b!.id, 'pc-conflict', owner)
  db.auditLog = []
  const rows = db.deviceRows.slice(0, 8)
  db.deviceRows = rows
  const hosts = [
    'pc-move',
    'pc-override',
    'no-match',
    'pc-same',
    'pc-conflict',
    'pc-pending',
    'pc-rejected',
    'pc-archived',
  ]
  rows.forEach((d, i) => {
    d.hostname = hosts[i]!
    d.state = i < 5 ? 'approved' : i === 5 ? 'pending' : i === 6 ? 'rejected' : 'archived'
    d.group_id = i === 0 || i > 4 ? null : i < 3 ? b!.id : a!.id
    d.open_alerts = []
  })
  const before = JSON.stringify({ rows, audit: db.auditLog })
  const preview = db.autoSortPreview()
  expect(JSON.stringify({ rows, audit: db.auditLog })).toBe(before)
  expect(preview.moves.map((m) => m.device.hostname)).toEqual(['pc-move', 'pc-override'])
  expect(preview.conflicts.map((c) => c.device.hostname)).toEqual(['pc-conflict'])
  expect(preview.unchanged).toBe(2)
  expect(db.autoSort(owner)).toEqual(preview)
  expect(rows[0]!.group_id).toBe(a!.id)
  expect(rows[1]!.group_id).toBe(a!.id)
  expect(rows[2]!.group_id).toBe(b!.id)
  expect(rows.slice(5).every((d) => d.group_id === null && d.open_alerts.length === 0)).toBe(true)
  const alert = structuredClone(rows[4]!.open_alerts[0])
  expect(db.autoSort(owner).moves).toEqual([])
  expect(rows[4]!.open_alerts).toEqual([alert])
  expect(db.auditLog.filter((e) => e.action === 'device.updated')).toHaveLength(2)
  expect(db.auditLog.find((e) => e.action === 'devices.auto_sorted')?.details).toEqual({
    moved: 0,
    conflicts: 1,
    resolved: 0,
    unchanged: 4,
  })
  const attention = summary(db).attention.find((a) => a.kind === 'group_conflict')
  expect(attention).toMatchObject({
    device_id: rows[4]!.id,
    since: alert!.created_at,
    detail: [a!.name, b!.name].sort().join(', '),
  })
  expect(summary(db, { devices: new Set(), groups: new Set() }).attention).toEqual([])
  db.groupRules = db.groupRules.filter((r) => r.group_id === a!.id)
  expect(db.autoSort(owner).conflicts).toEqual([])
  expect(rows[4]!.open_alerts).toEqual([])
  expect(summary(db).attention.some((a) => a.kind === 'group_conflict')).toBe(false)
})

it('matches runes with ASCII case folding and rejects trailing newlines', () => {
  expect(matchHostname('w-??-*', 'W-SF-😀')).toBe(true)
  expect(matchHostname('?', 'İ')).toBe(true)
  expect(matchHostname('k', 'K')).toBe(false)
  expect(validPattern('pc\n')).toBe(false)
})

it('previews pending devices, places approvals, replaces conflicts, and resolves a manual move', () => {
  const db = createMockDB('small')
  const owner = db.users.find((u) => u.role === 'owner')!
  const pending = db.deviceRows.find((d) => d.state === 'pending')!
  pending.hostname = 'w-sf-it-1'
  pending.group_id = null
  db.groupRules = []
  const [a, b] = db.groups
  expect(db.addGroupRule(a!.id, 'w-*-it-*', owner).ok).toBe(true)
  expect(db.addGroupRule(a!.id, 'W-*-IT-*', owner)).toMatchObject({
    ok: false,
    code: 'pattern_taken',
  })
  expect(db.previewGroupRule(a!.id, 'w-*')).toMatchObject({
    ok: true,
    value: { match_count: 1, conflicts: [] },
  })
  expect(db.transition(pending.id, 'approve', owner)).toMatchObject({
    ok: true,
    value: { group_id: a!.id },
  })
  expect(db.auditLog.find((e) => e.action === 'device.approved')?.details).toMatchObject({
    group_id: a!.id,
    pattern: 'w-*-it-*',
  })
  db.transition(pending.id, 'reopen', owner)
  pending.group_id = null
  db.addGroupRule(b!.id, 'w-*', owner)
  expect(db.previewGroupRule(a!.id, 'w-*')).toMatchObject({
    ok: true,
    value: {
      match_count: 1,
      conflicts: [
        {
          groups: expect.arrayContaining([
            { id: a!.id, name: a!.name },
            { id: b!.id, name: b!.name },
          ]),
        },
      ],
    },
  })
  db.transition(pending.id, 'approve', owner)
  expect(pending.open_alerts).toHaveLength(1)
  expect(pending.open_alerts[0]).toMatchObject({
    kind: 'group_conflict',
    groups: expect.any(Array),
  })
  const alertId = pending.open_alerts[0]!.id
  expect(db.resolveAlert(pending.id, alertId, 'accept_new_uuid', owner)).toMatchObject({
    ok: false,
    status: 400,
  })
  db.transition(pending.id, 'reopen', owner)
  db.transition(pending.id, 'approve', owner)
  expect(pending.open_alerts).toHaveLength(1)
  expect(pending.open_alerts[0]!.id).toBe(alertId)
  db.patchDevice(pending.id, { group_id: a!.id }, owner)
  expect(pending.open_alerts).toHaveLength(0)
  expect(db.auditLog.find((e) => e.action === 'device.updated')?.details).toMatchObject({
    reason: 'conflict_resolved',
  })
})

it('validates patterns and enforces the per-group limit', () => {
  const db = createMockDB('small'),
    owner = db.users.find((u) => u.role === 'owner')!,
    g = db.groups[0]!.id
  db.groupRules = []
  for (const p of ['', 'a b', 'ü', 'a'.repeat(129), 'a[1]'])
    expect(db.addGroupRule(g, p, owner)).toMatchObject({ ok: false, status: 400 })
  for (let i = 0; i < 20; i++) expect(db.addGroupRule(g, `p${i}`, owner).ok).toBe(true)
  expect(db.addGroupRule(g, 'p20', owner)).toMatchObject({ ok: false, status: 400 })
  expect(db.removeGroupRule(db.groups[1]!.id, db.groupRules[0]!.id, owner)).toMatchObject({
    ok: false,
    status: 404,
  })
  expect(db.removeGroupRule(g, db.groupRules[0]!.id, owner).ok).toBe(true)
  expect(db.addGroupRule(g, 'p20', owner).ok).toBe(true)
})

it('resolves an old conflict when reapproval finds only one matching group', () => {
  const db = createMockDB('small')
  const owner = db.users.find((u) => u.role === 'owner')!
  const pending = db.deviceRows.find((d) => d.state === 'pending')!
  expect(db.transition(pending.id, 'approve', owner).ok).toBe(true)
  expect(pending.open_alerts).toHaveLength(1)
  db.transition(pending.id, 'reopen', owner)
  const removed = db.groupRules[1]!
  db.removeGroupRule(removed.group_id, removed.id, owner)
  expect(db.transition(pending.id, 'approve', owner)).toMatchObject({
    ok: true,
    value: { group_id: db.groupRules[0]!.group_id, open_alerts: [] },
  })
})

it('reevaluates conflicts when a rule is removed or its group is deleted', () => {
  const db = createMockDB('small')
  const owner = db.users.find((u) => u.role === 'owner')!
  const device = db.deviceRows.find((d) => d.state === 'pending')!
  device.hostname = 'w-sf-it-1'
  db.groupRules = []
  const [a, b] = db.groups
  db.addGroupRule(a!.id, 'w-*-it-*', owner)
  const removed = db.addGroupRule(b!.id, 'w-sf-*', owner)
  if (!removed.ok) throw new Error('expected rule creation')
  device.open_alerts = [
    {
      id: 'conflict-rule-remove',
      kind: 'group_conflict',
      seen_uuid: null,
      ip: null,
      created_at: new Date(0).toISOString(),
      window_closed_at: null,
      groups: [
        { id: a!.id, name: a!.name },
        { id: b!.id, name: b!.name },
      ],
    },
  ]
  expect(db.removeGroupRule(b!.id, removed.value.id, owner).ok).toBe(true)
  expect(device.open_alerts).toEqual([])
  expect(db.auditLog.find((e) => e.action === 'group.rule_removed')?.details).toMatchObject({
    conflicts_resolved: [device.id],
  })

  const third = db.addGroupRule(b!.id, 'w-sf-*', owner)
  if (!third.ok) throw new Error('expected rule creation')
  const c = { ...a!, id: 'third-group', name: 'Third' }
  db.groups.push(c)
  db.addGroupRule(c.id, 'w-*-it-*', owner)
  device.open_alerts = [
    {
      id: 'conflict-rule-update',
      kind: 'group_conflict',
      seen_uuid: null,
      ip: null,
      created_at: new Date(0).toISOString(),
      window_closed_at: null,
      groups: [
        { id: a!.id, name: a!.name },
        { id: b!.id, name: b!.name },
        { id: c.id, name: c.name },
      ],
    },
  ]
  expect(db.removeGroupRule(b!.id, third.value.id, owner).ok).toBe(true)
  expect(device.open_alerts[0]!.groups.map((g) => g.id)).toEqual([a!.id, c.id])
  expect(db.auditLog.find((e) => e.action === 'group.rule_removed')?.details).toMatchObject({
    conflicts_updated: [device.id],
  })

  db.groupRules = db.groupRules.filter((r) => r.group_id !== b!.id)
  const created = db.createGroup('Delete target', null, owner)
  if (!created.ok) throw new Error('expected group creation')
  device.open_alerts = [
    {
      id: 'conflict-group-delete',
      kind: 'group_conflict',
      seen_uuid: null,
      ip: null,
      created_at: new Date(0).toISOString(),
      window_closed_at: null,
      groups: [
        { id: a!.id, name: a!.name },
        { id: created.value.id, name: created.value.name },
      ],
    },
  ]
  expect(db.deleteGroup(created.value.id, owner).ok).toBe(true)
  expect(device.open_alerts).toEqual([])
  expect(db.auditLog.find((e) => e.action === 'group.deleted')?.details).toMatchObject({
    conflicts_resolved: [device.id],
  })
})

it('keeps a preset group without rules when one other group matches', () => {
  const db = createMockDB('small')
  const owner = db.users.find((u) => u.role === 'owner')!
  const pending = db.deviceRows.find((d) => d.state === 'pending')!
  const [manual, matching] = db.groups
  manual!.name = 'Manual'
  db.groupRules = db.groupRules.filter((r) => r.group_id === matching!.id)
  expect(db.patchDevice(pending.id, { group_id: manual!.id }, owner).ok).toBe(true)
  expect(db.transition(pending.id, 'approve', owner)).toMatchObject({
    ok: true,
    value: { group_id: manual!.id, open_alerts: [] },
  })
  const details = db.auditLog.find((e) => e.action === 'device.approved')!.details
  expect(details).not.toHaveProperty('group_id')
  expect(details).not.toHaveProperty('pattern')
})

it('resolves a conflict when group_id is explicitly set to the current group, but not on alias-only PATCH', () => {
  const db = createMockDB('small')
  const owner = db.users.find((u) => u.role === 'owner')!
  const device = db.deviceRows.find((d) => d.state === 'pending')!
  expect(db.transition(device.id, 'approve', owner).ok).toBe(true)
  expect(device.open_alerts).toHaveLength(1)
  const currentGroup = device.open_alerts[0]!.groups[0]!.id
  device.group_id = currentGroup

  expect(db.patchDevice(device.id, { alias: 'still conflicted' }, owner).ok).toBe(true)
  expect(device.open_alerts).toHaveLength(1)

  expect(db.patchDevice(device.id, { group_id: currentGroup }, owner).ok).toBe(true)
  expect(device.open_alerts).toHaveLength(0)
  expect(db.auditLog.find((e) => e.action === 'device.updated')?.details).toMatchObject({
    reason: 'conflict_resolved',
  })
})

it('limits hostname bytes', () => {
  expect(matchHostname('*', 'é'.repeat(128))).toBe(false)
})

it('caps preview conflicts while returning total counts', () => {
  const db = createMockDB('medium')
  const owner = db.users.find((u) => u.role === 'owner')!
  const [a, b] = db.groups
  db.groupRules = []
  db.addGroupRule(a!.id, '*', owner)
  db.deviceRows = Array.from({ length: 205 }, (_, i) => ({
    ...structuredClone(db.deviceRows[0]!),
    id: `d${i}`,
    hostname: `pc${i}`,
    state: 'approved' as const,
  }))
  expect(db.previewGroupRule(b!.id, '*')).toMatchObject({
    ok: true,
    value: { conflict_count: 205, conflicts: expect.any(Array) },
  })
  const result = db.previewGroupRule(b!.id, '*')
  if (result.ok) expect(result.value.conflicts).toHaveLength(200)
})

it('hides ungranted group names and non-approved conflicts from attention', () => {
  const db = createMockDB('small')
  const owner = db.users.find((u) => u.role === 'owner')!
  const pending = db.deviceRows.find((d) => d.state === 'pending')!
  db.transition(pending.id, 'approve', owner)
  const a = db.groups[0]!
  expect(
    summary(db, { devices: new Set([pending.id]), groups: new Set([a.id]) }).attention.find(
      (a) => a.kind === 'group_conflict',
    )?.detail,
  ).toBe(a.name)
  db.transition(pending.id, 'reopen', owner)
  expect(
    summary(db).attention.some((a) => a.device_id === pending.id && a.kind === 'group_conflict'),
  ).toBe(false)
})

it('audits resolutions during auto sort', () => {
  const db = createMockDB('small')
  const owner = db.users.find((u) => u.role === 'owner')!
  const pending = db.deviceRows.find((d) => d.state === 'pending')!
  db.transition(pending.id, 'approve', owner)
  db.groupRules = []
  db.autoSort(owner)
  expect(db.auditLog.find((e) => e.action === 'devices.auto_sorted')?.details).toMatchObject({
    resolved: 1,
  })
})

it('resolves and audits stale conflicts on reapproval with no matches', () => {
  const db = createMockDB('small')
  const owner = db.users.find((u) => u.role === 'owner')!
  const pending = db.deviceRows.find((d) => d.state === 'pending')!
  db.transition(pending.id, 'approve', owner)
  db.transition(pending.id, 'reopen', owner)
  db.groupRules = []
  db.transition(pending.id, 'approve', owner)
  expect(pending.open_alerts).toEqual([])
  expect(db.auditLog.find((e) => e.action === 'device.approved')?.details).toMatchObject({
    conflict_resolved: true,
  })
})
