// The mock's stateful database. Reads and writes go through methods that keep
// the same rules as the real backend (transitions, uniqueness, audit entries
// for every change) and tell subscribers with a LiveEvent, so the dashboard
// updates live in the mock exactly as it will against ferricade.
import type { MockSize } from './config'
import type { components } from '../api/schema'
import { createAudit } from './fixtures/audit'
import { CATALOG, offersSize, presetPreferences } from './fixtures/catalog'
import { hasPermission } from './permissions'
import { matchHostname, validPattern } from './groupRules'
import { createDevices } from './fixtures/devices'
import { createGroupsAndTags, DEFAULT_POLICY_ID } from './fixtures/groups'
import { createSnapshots } from './fixtures/history'
import { createRng, iso } from './fixtures/rng'
import { createServer } from './fixtures/server'
import { createSessions } from './fixtures/sessions'
import type {
  Alert,
  AuditEvent,
  DashboardThresholds,
  Device,
  DeviceRow,
  Group,
  GroupRow,
  LiveEvent,
  Preferences,
  RemoteSession,
  Server,
  SessionRow,
  Snapshot,
  Tag,
  User,
} from './fixtures/types'
import { createUsers, HELPDESK_ID } from './fixtures/users'
import { DEMO } from './config'
import { badRequest, fail, notFound, ok, type Result } from './validate'

export interface MockDBOptions {
  /** The clock used for everything the mock writes. Defaults to the real time. */
  clock?: () => number
  /**
   * Where saved preferences outlive the MockDB (a reload). The browser mock
   * passes sessionStorage; tests pass nothing, so cases cannot see each other.
   */
  preferencesStore?: Pick<Storage, 'getItem' | 'setItem'>
  /** Where system sign-in settings outlive the MockDB (a reload). */
  sessionSettingsStore?: Pick<Storage, 'getItem' | 'setItem'>
}

const PREFERENCES_KEY = 'ferricade-mock-preferences-'
const SESSION_SETTINGS_KEY = 'ferricade-mock-session-settings'

export const ADMIN_IP = '192.168.1.20'
type UserGrants = components['schemas']['UserGrants']
type Policy = components['schemas']['Policy']
type PolicyPush = components['schemas']['PolicyPush']
type SessionSettings = components['schemas']['SessionSettings']
type LogExport = components['schemas']['LogExport']
type LogExportSettings = components['schemas']['LogExportSettings']
type AccessWindow = components['schemas']['AccessWindow']
type DevicePolicyStatus = components['schemas']['DevicePolicyStatus']
type DeviceIdAllowList = components['schemas']['DeviceIdAllowList']
type EffectiveId = DeviceIdAllowList['effective'][number]
type WindowRecord = {
  deviceId: string
  window: AccessWindow
  closedAt: string | null
  confirmed: boolean
  alertId: string | null
}
const SIZE_SEED: Record<MockSize, number> = { small: 11, medium: 22, large: 33 }

export interface SetupState {
  complete: boolean
  ownerCreated: boolean
  totpGenerated: boolean
  totpVerified: boolean
  serverSaved: boolean
}

const DEFAULT_THRESHOLDS: DashboardThresholds = {
  offline_days: 7,
  pending_hours: 24,
  min_client_version: '',
}

type DeviceAction = 'approve' | 'reject' | 'archive' | 'restore' | 'reopen'
const TRANSITIONS: Record<
  DeviceAction,
  { from: DeviceRow['state'][]; to: DeviceRow['state']; audit: string }
> = {
  approve: { from: ['pending', 'rejected'], to: 'approved', audit: 'device.approved' },
  reject: { from: ['pending'], to: 'rejected', audit: 'device.rejected' },
  archive: { from: ['approved'], to: 'archived', audit: 'device.archived' },
  restore: { from: ['archived'], to: 'approved', audit: 'device.restored' },
  reopen: { from: ['rejected', 'approved'], to: 'pending', audit: 'device.reopened' },
}

export class MockDB {
  readonly size: MockSize
  readonly clock: () => number

  users: User[]
  grants = new Map<string, UserGrants>()
  /** Users with a confirmed TOTP secret. */
  totpEnrolled: Set<string>
  /** Plain text on purpose: this is a mock. Keyed by user id. */
  passwords = new Map<string, string>()
  server: Server | null
  groups: GroupRow[]
  globalIdAllowList: string[] = []
  groupIdAllowLists = new Map<string, string[]>()
  deviceIdAllowLists = new Map<string, string[]>()
  groupRules: components['schemas']['GroupRule'][] = []
  policies: Policy[]
  policyPush: PolicyPush
  sessionSettings: SessionSettings = { lifetime: 'browser', updated_at: null, updated_by: null }
  logExport: LogExport
  accessWindows: WindowRecord[] = []
  deviceVersionSeen = new Map<string, boolean>()
  tags: Tag[]
  deviceRows: DeviceRow[]
  online: Set<string>
  sessionRows: SessionRow[]
  snapshots: Snapshot[]
  /** Newest first. */
  auditLog: AuditEvent[]
  thresholds: DashboardThresholds = { ...DEFAULT_THRESHOLDS }
  preferences = new Map<string, Preferences>()
  private readonly preferencesStore: MockDBOptions['preferencesStore']
  private readonly sessionSettingsStore: MockDBOptions['sessionSettingsStore']
  setup: SetupState = {
    complete: true,
    ownerCreated: true,
    totpGenerated: true,
    totpVerified: true,
    serverSaved: true,
  }

  private listeners = new Set<(event: LiveEvent) => void>()
  /** Makes the ids of what is created while the mock runs. */
  private rng

  constructor(size: MockSize, options: MockDBOptions = {}) {
    this.size = size
    this.clock = options.clock ?? Date.now
    this.preferencesStore = options.preferencesStore
    this.sessionSettingsStore = options.sessionSettingsStore
    try {
      const raw = this.sessionSettingsStore?.getItem(SESSION_SETTINGS_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as SessionSettings
        if (
          ['browser', '8h', '1d', '7d', '30d'].includes(saved.lifetime) &&
          (saved.updated_at === null || typeof saved.updated_at === 'string') &&
          (saved.updated_by === null || typeof saved.updated_by === 'object')
        ) {
          this.sessionSettings = saved
        }
      }
    } catch {
      // Junk or blocked storage: use the default.
    }
    const now = this.clock()
    const rng = createRng(SIZE_SEED[size])
    this.rng = createRng(SIZE_SEED[size] + 1000)
    this.users = createUsers(size)
    for (const u of this.users) this.passwords.set(u.id, DEMO.password)
    this.totpEnrolled = new Set(this.users.filter((u) => u.totp_required).map((u) => u.id))
    this.server = createServer(now)
    const { groups, tags } = createGroupsAndTags(size)
    this.groups = groups
    this.policies = [
      {
        id: DEFAULT_POLICY_ID,
        name: 'Default',
        is_default: true,
        settings: { 'approve-mode': 'password-click', 'verification-method': 'use-both-passwords' },
        updated_at: iso(now),
        updated_by: null,
      },
    ]
    this.policyPush = { enabled: false, updated_at: iso(now), updated_by: null }
    this.logExport = {
      settings: {
        file: { enabled: false },
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
      status: {
        file: { pending: 0, last_delivered_at: null, last_error: null, last_error_at: null },
        syslog: { pending: 0, last_delivered_at: null, last_error: null, last_error_at: null },
      },
      updated_at: iso(now),
      updated_by: null,
    }
    this.tags = tags
    const { devices, online } = createDevices(size, rng, now, groups, tags)
    this.deviceRows = devices
    const pendingRuleDevice = devices.filter((d) => d.state === 'pending').at(-1)
    if (pendingRuleDevice && groups.length >= 2) {
      pendingRuleDevice.hostname = 'w-sf-it-1'
      pendingRuleDevice.group_id = null
      this.groupRules = groups.slice(0, 2).map((g, i) => ({
        id: rng.uuid(),
        group_id: g.id,
        pattern: i === 0 ? 'w-*-it-*' : 'w-sf-*',
        created_at: iso(now),
        created_by: null,
      }))
    }
    this.grants.set(HELPDESK_ID, {
      group_ids: groups.length ? [groups[0]!.id] : [],
      device_ids: devices
        .filter((device) => device.state === 'approved')
        .slice(0, 1)
        .map((device) => device.id),
    })
    const approvedDevices = devices.filter((d) => d.state === 'approved')
    if (approvedDevices[0]) {
      this.globalIdAllowList = [approvedDevices[0].rustdesk_id, 'Tech_Desk_1']
      if (approvedDevices[1]) {
        this.deviceIdAllowLists.set(approvedDevices[0].id, [
          approvedDevices[1].rustdesk_id,
          'External_Admin',
        ])
      }
    }
    this.online = online
    this.sessionRows = createSessions(size, rng, now, devices, online)
    this.auditLog = createAudit(size, rng, now, devices, this.users)
    const approved = devices.filter((d) => d.state === 'approved')
    this.snapshots = createSnapshots(rng, now, {
      approved: approved.length,
      online: approved.filter((d) => online.has(d.id)).length,
      pending: devices.filter((d) => d.state === 'pending').length,
      sessions: this.sessionRows.filter((s) => s.ended_at === null && s.authed_at !== null).length,
    })
  }

  /** Timestamp for the next thing the mock writes. */
  now(): number {
    return this.clock()
  }

  newId(): string {
    return this.rng.uuid()
  }

  // ---- events -------------------------------------------------------------

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: LiveEvent): void {
    for (const l of [...this.listeners]) l(event)
  }

  snapshotCount(): number {
    return this.snapshots.length
  }

  idAllowListForDevice(deviceId: string): DeviceIdAllowList | undefined {
    const device = this.deviceRows.find((row) => row.id === deviceId)
    if (!device) return undefined
    const effective: EffectiveId[] = []
    const add = (
      ids: string[],
      source: EffectiveId['source'],
      groupId: string | null = null,
      groupName: string | null = null,
    ) => {
      for (const id of ids) {
        effective.push({ id, source, group_id: groupId, group_name: groupName })
      }
    }
    add(this.globalIdAllowList, 'global')
    const seenGroups = new Set<string>()
    let group = this.groups.find((row) => row.id === device.group_id)
    while (group) {
      for (const id of this.groupIdAllowLists.get(group.id) ?? []) {
        const key = id.toLowerCase()
        if (!seenGroups.has(key)) {
          seenGroups.add(key)
          add([id], 'group', group.id, group.name)
        }
      }
      group = this.groups.find((row) => row.id === group?.parent_id)
    }
    add(this.deviceIdAllowLists.get(deviceId) ?? [], 'device')
    effective.sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
    )
    return { ids: this.deviceIdAllowLists.get(deviceId) ?? [], effective }
  }

  setIDAllowList(
    scope: 'global' | 'group' | 'device',
    targetId: string,
    ids: string[],
    actor: User,
  ): string[] {
    const current =
      scope === 'global'
        ? this.globalIdAllowList
        : scope === 'group'
          ? (this.groupIdAllowLists.get(targetId) ?? [])
          : (this.deviceIdAllowLists.get(targetId) ?? [])
    const before = [...current]
    if (scope === 'global') this.globalIdAllowList = [...ids]
    else if (scope === 'group') this.groupIdAllowLists.set(targetId, [...ids])
    else this.deviceIdAllowLists.set(targetId, [...ids])
    this.record(actor, 'id_allow_list.updated', 'id_allow_list', targetId, {
      scope,
      target_id: targetId,
      before,
      after: ids,
    })
    this.emit({ type: 'id_allow_list.updated' })
    return ids
  }

  // ---- audit --------------------------------------------------------------

  /** Records an admin action, newest first, and announces it. */
  record(
    actor: User | null,
    action: string,
    targetType: string,
    targetId: string,
    details: Record<string, unknown> = {},
  ): void {
    const event: AuditEvent = {
      id: this.newId(),
      at: iso(this.now()),
      actor_user_id: actor?.id ?? null,
      actor_ip: ADMIN_IP,
      action,
      target_type: targetType,
      target_id: targetId,
      details,
    }
    this.auditLog.unshift(event)
    this.emit({ type: 'audit.created', audit_id: event.id })
  }

  setSessionSettings(lifetime: SessionSettings['lifetime'], actor: User): SessionSettings {
    const before = this.sessionSettings.lifetime
    if (before !== lifetime) {
      this.sessionSettings = {
        lifetime,
        updated_at: iso(this.now()),
        updated_by: { id: actor.id, display_name: actor.display_name },
      }
      try {
        this.sessionSettingsStore?.setItem(
          SESSION_SETTINGS_KEY,
          JSON.stringify(this.sessionSettings),
        )
      } catch {
        // Blocked or full storage does not prevent the in-memory mock update.
      }
      this.record(actor, 'session_lifetime.changed', 'settings', 'sessions', {
        before,
        after: lifetime,
      })
    }
    return this.sessionSettings
  }

  setLogExport(next: LogExportSettings, actor: User): LogExport {
    const before = this.logExport.settings
    const fields = [
      ...(before.file.enabled !== next.file.enabled ? ['file.enabled'] : []),
      ...(['enabled', 'host', 'port', 'tls', 'ca_pem', 'facility', 'format'] as const)
        .filter((key) => before.syslog[key] !== next.syslog[key])
        .map((key) => `syslog.${key}`),
    ].sort()
    if (fields.length) {
      this.logExport = {
        ...this.logExport,
        settings: structuredClone(next),
        updated_at: iso(this.now()),
        updated_by: { id: actor.id, display_name: actor.display_name },
      }
      this.record(actor, 'settings.log_export_updated', 'settings', 'log-export', { fields })
    }
    return this.logExport
  }

  // ---- users --------------------------------------------------------------

  findUser(id: string): User | undefined {
    return this.users.find((u) => u.id === id)
  }

  findUserByName(username: string): User | undefined {
    return this.users.find((u) => u.username.toLowerCase() === username.toLowerCase())
  }

  grantsFor(userId: string): UserGrants {
    const grants = this.grants.get(userId)
    return {
      group_ids: [...(grants?.group_ids ?? [])],
      device_ids: [...(grants?.device_ids ?? [])],
    }
  }

  replaceGrants(userId: string, grants: UserGrants, actor: User): Result<UserGrants> {
    const user = this.findUser(userId)
    if (!user) return notFound('user not found')
    if (user.role !== 'user')
      return fail(409, 'bad_transition', 'grants apply to the user role only')
    if (grants.group_ids.some((id) => !this.groups.some((group) => group.id === id)))
      return badRequest('unknown group')
    if (grants.device_ids.some((id) => !this.deviceRows.some((device) => device.id === id)))
      return badRequest('unknown device')
    const before = this.grantsFor(userId)
    const saved = {
      group_ids: [...grants.group_ids],
      device_ids: [...grants.device_ids],
    }
    this.grants.set(userId, saved)
    this.record(actor, 'user.grants_updated', 'user', userId, {
      added_group_ids: saved.group_ids.filter((id) => !before.group_ids.includes(id)),
      removed_group_ids: before.group_ids.filter((id) => !saved.group_ids.includes(id)),
      added_device_ids: saved.device_ids.filter((id) => !before.device_ids.includes(id)),
      removed_device_ids: before.device_ids.filter((id) => !saved.device_ids.includes(id)),
    })
    return ok(this.grantsFor(userId))
  }

  /**
   * The groups a User sees: the granted ones and all their descendants (as the
   * server's visible-group set).
   */
  visibleGroupIds(userId: string): Set<string> {
    const visible = new Set(
      this.grantsFor(userId).group_ids.filter((id) => this.groups.some((g) => g.id === id)),
    )
    for (let grew = true; grew;) {
      grew = false
      for (const g of this.groups) {
        if (g.parent_id !== null && visible.has(g.parent_id) && !visible.has(g.id)) {
          visible.add(g.id)
          grew = true
        }
      }
    }
    return visible
  }

  /** The devices a User sees: approved ones granted directly or in a visible group. */
  visibleDeviceIds(userId: string): Set<string> {
    const grants = this.grantsFor(userId)
    const groups = this.visibleGroupIds(userId)
    return new Set(
      this.deviceRows
        .filter(
          (d) =>
            d.state === 'approved' &&
            (grants.device_ids.includes(d.id) || (d.group_id !== null && groups.has(d.group_id))),
        )
        .map((d) => d.id),
    )
  }

  // ---- devices ------------------------------------------------------------

  deviceView(row: DeviceRow): Device {
    const { tag_ids, ...rest } = row
    return {
      ...rest,
      open_alerts: row.open_alerts.map((a) => ({
        ...a,
        groups: a.groups
          .filter((g) => this.groups.some((existing) => existing.id === g.id))
          .map((g) => ({
            id: g.id,
            name: this.groups.find((existing) => existing.id === g.id)!.name,
          })),
      })),
      tags: tag_ids.flatMap((id) => this.tags.filter((t) => t.id === id)),
      online: this.online.has(row.id),
      conns: this.sessionRows
        .filter((s) => s.device_id === row.id && s.ended_at === null)
        .map((s) => s.conn_id),
    }
  }

  /**
   * A device as a User sees it (devices.go hideForUser): no approver, the group
   * only when it is one of theirs, empty alert addresses.
   */
  deviceViewForUser(d: Device, userId: string): Device {
    const groups = this.visibleGroupIds(userId)
    return {
      ...d,
      approved_by: null,
      group_id: d.group_id !== null && groups.has(d.group_id) ? d.group_id : null,
      open_alerts: d.open_alerts.map((a) => ({
        ...a,
        ip: a.ip === null ? null : '',
        groups: a.groups.filter((g) => groups.has(g.id)),
      })),
    }
  }

  devices(): Device[] {
    return this.deviceRows.map((r) => this.deviceView(r))
  }

  device(id: string): Device | undefined {
    const row = this.deviceRows.find((d) => d.id === id)
    return row && this.deviceView(row)
  }

  deviceName(d: Pick<DeviceRow, 'alias' | 'hostname' | 'rustdesk_id'>): string {
    return d.alias || d.hostname || d.rustdesk_id
  }

  transition(id: string, action: DeviceAction, actor: User): Result<Device> {
    const row = this.deviceRows.find((d) => d.id === id)
    if (!row) return notFound('device not found')
    const t = TRANSITIONS[action]
    if (!t.from.includes(row.state)) {
      return fail(409, 'bad_transition', `cannot ${action} a ${row.state} device`)
    }
    if (
      row.state === 'approved' &&
      this.accessWindows.some((w) => w.deviceId === id && w.closedAt === null)
    )
      return fail(409, 'window_open', 'close the access window first')
    const before = row.state
    const placement: Record<string, unknown> = {}
    if (action === 'approve' && row.group_id === null) {
      const groups = this.ruleCandidates(row.hostname)
      if (groups.length === 1) {
        row.group_id = groups[0]!
        placement.group_id = row.group_id
        placement.pattern = this.groupRules.find(
          (r) => r.group_id === row.group_id && matchHostname(r.pattern, row.hostname),
        )!.pattern
      } else if (groups.length > 1) {
        const refs = this.groups
          .filter((g) => groups.includes(g.id))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(({ id, name }) => ({ id, name }))
        const existing = row.open_alerts.find((a) => a.kind === 'group_conflict')
        if (existing) existing.groups = refs
        else
          row.open_alerts.push({
            id: this.rng.uuid(),
            kind: 'group_conflict',
            seen_uuid: null,
            ip: null,
            created_at: iso(this.now()),
            window_closed_at: null,
            groups: refs,
          })
      }
      if (groups.length <= 1 && row.open_alerts.some((a) => a.kind === 'group_conflict')) {
        row.open_alerts = row.open_alerts.filter((a) => a.kind !== 'group_conflict')
        placement.conflict_resolved = true
      }
    }
    row.state = t.to
    const at = iso(this.now())
    if (action === 'approve' || action === 'restore') {
      row.approved_by = actor.id
      row.approved_at = at
    } else if (action === 'reopen') {
      row.approved_by = null
      row.approved_at = null
    }
    row.updated_at = at
    if (row.state !== 'approved' && row.state !== 'pending') this.online.delete(row.id)
    this.emit({ type: 'device.updated', device_id: row.id })
    this.record(actor, t.audit, 'device', row.id, {
      from: before,
      to: row.state,
      ...placement,
      before: { state: before },
      after: { state: row.state },
    })
    return ok(this.deviceView(row))
  }

  // Like the server: any state; its tags, alerts and sessions go with it, and
  // the audit entry keeps what identified it.
  deleteDevice(id: string, actor: User): Result<null> {
    const row = this.deviceRows.find((d) => d.id === id)
    if (!row) return notFound('device not found')
    if (this.accessWindows.some((w) => w.deviceId === id && w.closedAt === null))
      return fail(409, 'window_open', 'close the access window first')
    const sessions = this.sessionRows.filter((s) => s.device_id === id).length
    this.deviceRows = this.deviceRows.filter((d) => d.id !== id)
    this.accessWindows = this.accessWindows.filter((w) => w.deviceId !== id)
    this.deviceVersionSeen.delete(id)
    this.sessionRows = this.sessionRows.filter((s) => s.device_id !== id)
    this.online.delete(id)
    this.emit({ type: 'device.deleted', device_id: id })
    this.record(actor, 'device.deleted', 'device', id, {
      rustdesk_id: row.rustdesk_id,
      hostname: row.hostname,
      alias: row.alias,
      state: row.state,
      sessions,
    })
    return ok(null)
  }

  patchDevice(
    id: string,
    patch: { alias?: string; note?: string; group_id?: string | null; tag_ids?: string[] },
    actor: User,
  ): Result<Device> {
    const row = this.deviceRows.find((d) => d.id === id)
    if (!row) return notFound('device not found')
    if (patch.group_id && !this.groups.some((g) => g.id === patch.group_id))
      return badRequest('group_id does not name a group')
    if (patch.tag_ids?.some((t) => !this.tags.some((x) => x.id === t)))
      return badRequest('unknown tag')
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    const change = <K extends 'alias' | 'note' | 'group_id' | 'tag_ids'>(
      key: K,
      value: DeviceRow[K] | undefined,
    ) => {
      if (value === undefined || JSON.stringify(row[key]) === JSON.stringify(value)) return
      before[key] = row[key]
      after[key] = value
      row[key] = value
    }
    change('alias', patch.alias)
    change('note', patch.note)
    change('group_id', patch.group_id)
    change('tag_ids', patch.tag_ids)
    const conflictResolved =
      Object.hasOwn(patch, 'group_id') && row.open_alerts.some((a) => a.kind === 'group_conflict')
    if (conflictResolved)
      row.open_alerts = row.open_alerts.filter((a) => a.kind !== 'group_conflict')
    row.updated_at = iso(this.now())
    this.emit({ type: 'device.updated', device_id: row.id })
    this.record(actor, 'device.updated', 'device', row.id, {
      before,
      after,
      ...(conflictResolved ? { reason: 'conflict_resolved' } : {}),
    })
    return ok(this.deviceView(row))
  }

  resolveAlert(
    id: string,
    alertId: string,
    action: 'accept_new_uuid' | 'dismiss',
    actor: User,
  ): Result<Device> {
    const row = this.deviceRows.find((d) => d.id === id)
    const alert: Alert | undefined = row?.open_alerts.find((a) => a.id === alertId)
    if (!row || !alert) return notFound('alert not found')
    if (action === 'accept_new_uuid') {
      if (alert.kind !== 'uuid_mismatch' || alert.seen_uuid === null)
        return badRequest('action: accept_new_uuid applies only to uuid_mismatch alerts')
      row.uuid = alert.seen_uuid
    }
    row.open_alerts = row.open_alerts.filter((a) => a.id !== alertId)
    row.updated_at = iso(this.now())
    this.emit({ type: 'device.updated', device_id: row.id })
    this.record(actor, 'device.alert_resolved', 'device', row.id, {
      alert_id: alertId,
      kind: alert.kind,
      action,
    })
    return ok(this.deviceView(row))
  }

  /** Flips a random approved device online or offline (dev-only background activity). */
  toggleRandomDeviceOnline(): void {
    const approved = this.deviceRows.filter((d) => d.state === 'approved')
    if (approved.length === 0) return
    const row = approved[Math.floor(Math.random() * approved.length)]!
    const wasOnline = this.online.has(row.id)
    if (wasOnline) this.online.delete(row.id)
    else {
      this.online.add(row.id)
      row.last_seen_at = iso(this.now())
    }
    this.emit({ type: wasOnline ? 'device.offline' : 'device.online', device_id: row.id })
  }

  // ---- groups -------------------------------------------------------------

  private resolvedDevicePolicy(
    deviceId: string,
  ): Pick<
    DevicePolicyStatus,
    'policy' | 'source' | 'source_group' | 'effective_settings' | 'always_reachable'
  > {
    const device = this.deviceRows.find((d) => d.id === deviceId)!
    let group = this.groups.find((g) => g.id === device.group_id)
    let source: DevicePolicyStatus['source'] = 'default'
    let sourceGroup: DevicePolicyStatus['source_group'] = null
    let chosen = this.policies.find((p) => p.is_default)!
    let depth = 0
    while (group) {
      if (group.policy_id) {
        chosen = this.policies.find((p) => p.id === group!.policy_id) ?? chosen
        source = depth === 0 ? 'group' : 'parent_group'
        sourceGroup = { id: group.id, name: group.name }
        break
      }
      group = this.groups.find((g) => g.id === group?.parent_id)
      depth++
    }
    const settings = chosen.settings
    const alwaysReachable =
      ['password', 'password-click'].includes(settings['approve-mode'] ?? '') &&
      ['use-permanent-password', 'use-both-passwords'].includes(
        settings['verification-method'] ?? '',
      )
    return {
      policy: { id: chosen.id, name: chosen.name },
      source,
      source_group: sourceGroup,
      effective_settings: {
        ...settings,
        ...(hasPermission(settings) && !('access-mode' in settings)
          ? { 'access-mode': 'custom' }
          : {}),
      },
      always_reachable: alwaysReachable,
    }
  }

  private latestWindow(deviceId: string): WindowRecord | undefined {
    return this.accessWindows.findLast((w) => w.deviceId === deviceId)
  }

  private requestDeviceDisconnect(deviceId: string): number {
    let sessions = 0
    for (const row of this.sessionRows) {
      if (
        row.device_id !== deviceId ||
        row.ended_at !== null ||
        row.disconnect_requested_at !== null
      )
        continue
      row.disconnect_requested_at = iso(this.now())
      this.emit({ type: 'session.updated', device_id: deviceId, session_id: row.id })
      sessions++
    }
    return sessions
  }

  sweepAccessWindows(): void {
    const now = this.now()
    for (const record of this.accessWindows) {
      if (
        record.closedAt !== null ||
        record.window.ends_at === null ||
        Date.parse(record.window.ends_at) > now
      )
        continue
      record.closedAt = record.window.ends_at
      const sessions = record.window.disconnect_on_close
        ? this.requestDeviceDisconnect(record.deviceId)
        : 0
      this.deviceVersionSeen.set(record.deviceId, false)
      this.emit({ type: 'device.updated', device_id: record.deviceId })
      this.record(null, 'access_window.closed', 'device', record.deviceId, {
        window_id: record.window.id,
        reason: 'expired',
        disconnect: record.window.disconnect_on_close,
        sessions,
      })
    }
    for (const device of this.deviceRows) {
      const openAlert = device.open_alerts.find((a) => a.kind === 'access_window_unconfirmed')
      if (
        openAlert &&
        !this.accessWindows.some((w) => w.alertId === openAlert.id && !w.confirmed)
      ) {
        device.open_alerts = device.open_alerts.filter((a) => a.id !== openAlert.id)
        this.emit({ type: 'device.updated', device_id: device.id })
      }
      const candidate = this.accessWindows.find(
        (w) =>
          w.deviceId === device.id &&
          w.closedAt !== null &&
          !w.confirmed &&
          w.alertId === null &&
          now - Date.parse(w.closedAt) >= 5 * 60_000,
      )
      if (candidate && !device.open_alerts.some((a) => a.kind === 'access_window_unconfirmed')) {
        const alertId = this.newId()
        device.open_alerts.push({
          id: alertId,
          kind: 'access_window_unconfirmed',
          seen_uuid: null,
          ip: null,
          window_closed_at: candidate.closedAt,
          groups: [],
          created_at: iso(now),
        })
        candidate.alertId = alertId
        this.emit({ type: 'device.updated', device_id: device.id })
      }
    }
  }

  devicePolicyStatus(deviceId: string): Result<DevicePolicyStatus> {
    this.sweepAccessWindows()
    if (!this.deviceRows.some((d) => d.id === deviceId)) return notFound()
    const resolved = this.resolvedDevicePolicy(deviceId)
    const latest = this.latestWindow(deviceId)
    const window = latest?.closedAt === null ? latest.window : null
    const windowOpen =
      window !== null && (window.ends_at === null || Date.parse(window.ends_at) > this.now())
    const effective = { ...resolved.effective_settings }
    if (windowOpen) {
      effective['approve-mode'] = 'password-click'
      effective['verification-method'] = 'use-both-passwords'
    }
    const status = !this.policyPush.enabled
      ? 'off'
      : this.deviceVersionSeen.get(deviceId) === true
        ? 'applied'
        : 'pending'
    const device = this.deviceRows.find((d) => d.id === deviceId)!
    const approve = resolved.effective_settings['approve-mode']
    const connect: DevicePolicyStatus['connect'] =
      !this.policyPush.enabled || resolved.always_reachable || device.state !== 'approved'
        ? 'unrestricted'
        : windowOpen
          ? 'window'
          : approve === 'click' || approve === 'password-click'
            ? 'attended'
            : 'locked'
    return ok({
      ...resolved,
      effective_settings: effective,
      push_enabled: this.policyPush.enabled,
      status,
      connect,
      window,
      close_unconfirmed_since:
        this.accessWindows
          .filter((w) => w.deviceId === deviceId && w.closedAt !== null && !w.confirmed)
          .map((w) => w.closedAt!)
          .sort()
          .at(-1) ?? null,
    })
  }

  openAccessWindow(
    deviceId: string,
    duration: number | null,
    disconnectOnClose: boolean,
    actor: User,
  ): Result<AccessWindow> {
    if (duration !== null && ![60, 240, 480].includes(duration))
      return badRequest('duration_minutes: not an allowed value')
    this.sweepAccessWindows()
    const device = this.deviceRows.find((d) => d.id === deviceId)
    if (!device) return notFound()
    if (device.state !== 'approved') return fail(409, 'bad_transition', 'device is not approved')
    if (!this.policyPush.enabled) return fail(409, 'push_off', 'policy push is off')
    if (this.resolvedDevicePolicy(deviceId).always_reachable)
      return fail(409, 'always_reachable', 'policy is always reachable')
    if (this.latestWindow(deviceId)?.closedAt === null)
      return fail(409, 'window_open', 'access window already open')
    const window: AccessWindow = {
      id: this.newId(),
      opened_by: { id: actor.id, display_name: actor.display_name },
      opened_at: iso(this.now()),
      ends_at: duration === null ? null : iso(this.now() + duration * 60_000),
      disconnect_on_close: disconnectOnClose,
    }
    this.accessWindows.push({ deviceId, window, closedAt: null, confirmed: false, alertId: null })
    this.deviceVersionSeen.set(deviceId, false)
    this.emit({ type: 'device.updated', device_id: deviceId })
    this.record(actor, 'access_window.opened', 'device', deviceId, {
      window_id: window.id,
      duration_minutes: duration,
      disconnect_on_close: disconnectOnClose,
    })
    return ok(window)
  }

  closeAccessWindow(deviceId: string, disconnect: boolean, actor: User): Result<null> {
    this.sweepAccessWindows()
    const latest = this.latestWindow(deviceId)
    if (!latest || latest.closedAt !== null) return notFound()
    latest.closedAt = iso(this.now())
    this.deviceVersionSeen.set(deviceId, false)
    const sessions = disconnect ? this.requestDeviceDisconnect(deviceId) : 0
    this.emit({ type: 'device.updated', device_id: deviceId })
    this.record(actor, 'access_window.closed', 'device', deviceId, {
      window_id: latest.window.id,
      reason: 'manual',
      disconnect,
      sessions,
    })
    return ok(null)
  }

  setDeviceVersionSeen(deviceId: string, applied: boolean): void {
    if (!this.deviceRows.some((d) => d.id === deviceId))
      throw new Error(`mock: no device ${deviceId}`)
    this.deviceVersionSeen.set(deviceId, applied)
    if (
      applied &&
      !this.accessWindows.some((w) => w.deviceId === deviceId && w.closedAt === null)
    ) {
      for (const window of this.accessWindows) {
        if (window.deviceId === deviceId && window.closedAt !== null) window.confirmed = true
      }
    }
    this.sweepAccessWindows()
    this.emit({ type: 'device.updated', device_id: deviceId })
  }

  listPolicies(): Policy[] {
    return [...this.policies].sort(
      (a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name),
    )
  }

  getPolicy(id: string): Result<Policy> {
    const policy = this.policies.find((p) => p.id === id)
    return policy ? ok(policy) : notFound()
  }

  createPolicy(name: string, settings: Policy['settings'], actor: User): Result<Policy> {
    if (this.policies.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      return fail(409, 'name_taken', 'name taken')
    const policy: Policy = {
      id: this.newId(),
      name,
      settings: { ...settings },
      is_default: false,
      updated_at: iso(this.now()),
      updated_by: { id: actor.id, display_name: actor.display_name },
    }
    this.policies.push(policy)
    this.record(actor, 'policy.created', 'policy', policy.id, { name })
    return ok(policy)
  }

  updatePolicy(
    id: string,
    name: string | undefined,
    settings: Policy['settings'] | undefined,
    actor: User,
  ): Result<Policy> {
    const policy = this.policies.find((p) => p.id === id)
    if (!policy) return notFound()
    if (policy.is_default && name !== undefined && name !== policy.name)
      return fail(409, 'default_policy', 'default policy')
    if (
      name !== undefined &&
      this.policies.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())
    )
      return fail(409, 'name_taken', 'name taken')
    if (name !== undefined) policy.name = name
    if (settings !== undefined) policy.settings = { ...settings }
    policy.updated_at = iso(this.now())
    policy.updated_by = { id: actor.id, display_name: actor.display_name }
    this.record(actor, 'policy.updated', 'policy', id, { name: policy.name })
    return ok(policy)
  }

  deletePolicy(id: string, actor: User): Result<null> {
    const policy = this.policies.find((p) => p.id === id)
    if (!policy) return notFound()
    if (policy.is_default) return fail(409, 'default_policy', 'default policy')
    if (this.groups.some((g) => g.policy_id === id)) return fail(409, 'in_use', 'policy in use')
    this.policies = this.policies.filter((p) => p.id !== id)
    this.record(actor, 'policy.deleted', 'policy', id, { name: policy.name })
    return ok(null)
  }

  setPolicyPush(enabled: boolean, actor: User): Result<PolicyPush> {
    this.sweepAccessWindows()
    if (!enabled && this.accessWindows.some((w) => w.closedAt === null))
      return fail(409, 'window_open', 'close the open access windows first')
    const wasEnabled = this.policyPush.enabled
    this.policyPush = {
      enabled,
      updated_at: iso(this.now()),
      updated_by: { id: actor.id, display_name: actor.display_name },
    }
    if (enabled !== wasEnabled)
      this.record(
        actor,
        enabled ? 'policy_push.enabled' : 'policy_push.disabled',
        'settings',
        'policy_push',
      )
    return ok(this.policyPush)
  }

  setGroupPolicy(id: string, policyId: string | null, actor: User): Result<Group> {
    const group = this.groups.find((g) => g.id === id)
    if (!group || (policyId !== null && !this.policies.some((p) => p.id === policyId)))
      return notFound()
    group.policy_id = policyId
    this.record(actor, 'group.policy_changed', 'group', id, { policy_id: policyId })
    return ok(this.groupView(group))
  }

  effectivePolicyId(group: GroupRow): string {
    const seen = new Set<string>()
    for (
      let current: GroupRow | undefined = group;
      current && !seen.has(current.id);
      current = this.groups.find((g) => g.id === current?.parent_id)
    ) {
      seen.add(current.id)
      if (current.policy_id) return current.policy_id
    }
    return DEFAULT_POLICY_ID
  }

  /** The group tree; with `only`, just those groups, a group whose parent is not in it being a root. */
  groupTree(only?: ReadonlySet<string>): Group[] {
    const byName = (a: GroupRow, b: GroupRow) => a.name.localeCompare(b.name)
    const groups = only ? this.groups.filter((g) => only.has(g.id)) : this.groups
    const build = (g: GroupRow): Group => ({
      ...g,
      effective_policy_id: this.effectivePolicyId(g),
      children: groups
        .filter((c) => c.parent_id === g.id)
        .sort(byName)
        .map(build),
    })
    return groups
      .filter((g) => g.parent_id === null || (only !== undefined && !only.has(g.parent_id)))
      .sort(byName)
      .map(build)
  }

  private groupView(g: GroupRow): Group {
    return { ...g, effective_policy_id: this.effectivePolicyId(g), children: [] }
  }

  private siblingTaken(parentId: string | null, name: string, exceptId?: string): boolean {
    return this.groups.some(
      (g) =>
        g.parent_id === parentId &&
        g.id !== exceptId &&
        g.name.toLowerCase() === name.toLowerCase(),
    )
  }

  createGroup(name: string, parentId: string | null, actor: User): Result<Group> {
    if (name.trim() === '') return badRequest('name must not be blank')
    if (parentId && !this.groups.some((g) => g.id === parentId))
      return badRequest('unknown parent group')
    if (this.siblingTaken(parentId, name))
      return fail(409, 'name_taken', 'a sibling group has this name')
    const group: GroupRow = {
      id: this.newId(),
      parent_id: parentId,
      name,
      policy_id: null,
      effective_policy_id: DEFAULT_POLICY_ID,
    }
    this.groups.push(group)
    this.record(actor, 'group.created', 'group', group.id, { name, parent_id: parentId })
    return ok(this.groupView(group))
  }

  renameGroup(id: string, name: string, actor: User): Result<Group> {
    const group = this.groups.find((g) => g.id === id)
    if (!group) return notFound('group not found')
    if (name.trim() === '') return badRequest('name must not be blank')
    if (this.siblingTaken(group.parent_id, name, id))
      return fail(409, 'name_taken', 'a sibling group has this name')
    const before = group.name
    group.name = name
    this.record(actor, 'group.renamed', 'group', id, { before: { name: before }, after: { name } })
    return ok(this.groupView(group))
  }

  moveGroup(id: string, parentId: string | null, actor: User): Result<Group> {
    const group = this.groups.find((g) => g.id === id)
    if (!group) return notFound('group not found')
    if (parentId && !this.groups.some((g) => g.id === parentId))
      return badRequest('unknown parent group')
    for (let p = parentId; p !== null; p = this.groups.find((g) => g.id === p)?.parent_id ?? null) {
      if (p === id) return fail(409, 'cycle', 'a group cannot move under itself')
    }
    if (this.siblingTaken(parentId, group.name, id))
      return fail(409, 'name_taken', 'a sibling group has this name')
    const before = group.parent_id
    group.parent_id = parentId
    this.record(actor, 'group.moved', 'group', id, {
      before: { parent_id: before },
      after: { parent_id: parentId },
    })
    return ok(this.groupView(group))
  }

  deleteGroup(id: string, actor: User): Result<null> {
    const group = this.groups.find((g) => g.id === id)
    if (!group) return notFound('group not found')
    if (
      this.groups.some((g) => g.parent_id === id) ||
      this.deviceRows.some((d) => d.group_id === id)
    ) {
      return fail(409, 'not_empty', 'the group has child groups or devices')
    }
    const conflicts = this.reevaluateGroupConflicts(id, () => false)
    this.groups = this.groups.filter((g) => g.id !== id)
    this.groupRules = this.groupRules.filter((r) => r.group_id !== id)
    this.record(actor, 'group.deleted', 'group', id, {
      name: group.name,
      ...(conflicts.updated.length ? { conflicts_updated: conflicts.updated } : {}),
      ...(conflicts.resolved.length ? { conflicts_resolved: conflicts.resolved } : {}),
    })
    return ok(null)
  }

  // ---- group rules --------------------------------------------------------

  autoSortPreview(): components['schemas']['AutoSortResult'] {
    const result: components['schemas']['AutoSortResult'] = {
      moves: [],
      conflicts: [],
      unchanged: 0,
    }
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
    const refs = (ids: string[]) =>
      ids.flatMap((id) =>
        this.groups.filter((g) => g.id === id).map(({ id, name }) => ({ id, name })),
      )
    for (const row of this.deviceRows
      .filter((d) => d.state === 'approved')
      .sort((a, b) => compare(a.hostname, b.hostname) || compare(a.id, b.id))) {
      const { id, rustdesk_id, hostname, alias, group_id } = row
      const device: components['schemas']['RuleDeviceRef'] = {
        id,
        rustdesk_id,
        hostname,
        alias,
        group_id,
        state: 'approved',
      }
      const ids = this.ruleCandidates(hostname)
      if (ids.length > 1) result.conflicts.push({ device, groups: refs(ids) })
      else if (ids.length === 1 && ids[0] !== group_id)
        result.moves.push({
          device,
          from_group: group_id ? refs([group_id])[0]! : null,
          to_group: refs(ids)[0]!,
        })
      else result.unchanged++
    }
    return result
  }

  autoSort(actor: User): components['schemas']['AutoSortResult'] {
    const result = this.autoSortPreview()
    for (const move of result.moves) {
      const row = this.deviceRows.find((d) => d.id === move.device.id)!
      row.group_id = move.to_group.id
      row.updated_at = iso(this.now())
      this.record(actor, 'device.updated', 'device', row.id, {
        before: { group_id: move.from_group?.id ?? null },
        after: { group_id: move.to_group.id },
        reason: 'auto_sort',
      })
      this.emit({ type: 'device.updated', device_id: row.id })
    }
    const conflicts = new Map(result.conflicts.map((c) => [c.device.id, c.groups]))
    let resolved = 0
    for (const row of this.deviceRows.filter((d) => d.state === 'approved')) {
      const groups = conflicts.get(row.id)
      const existing = row.open_alerts.find((a) => a.kind === 'group_conflict')
      if (groups) {
        if (existing) {
          if (JSON.stringify(existing.groups) === JSON.stringify(groups)) continue
          existing.groups = groups
        } else
          row.open_alerts.push({
            id: this.rng.uuid(),
            kind: 'group_conflict',
            seen_uuid: null,
            ip: null,
            created_at: iso(this.now()),
            window_closed_at: null,
            groups,
          })
      } else if (existing) {
        resolved++
        row.open_alerts = row.open_alerts.filter((a) => a.kind !== 'group_conflict')
      } else continue
      this.emit({ type: 'device.updated', device_id: row.id })
    }
    this.record(actor, 'devices.auto_sorted', 'devices', '', {
      moved: result.moves.length,
      conflicts: result.conflicts.length,
      resolved,
      unchanged: result.unchanged,
    })
    return result
  }

  ruleCandidates(hostname: string): string[] {
    return [
      ...new Set(
        this.groupRules.filter((r) => matchHostname(r.pattern, hostname)).map((r) => r.group_id),
      ),
    ].sort()
  }

  sortedGroupRules(): components['schemas']['GroupRule'][] {
    return [...this.groupRules].sort(
      (a, b) => a.group_id.localeCompare(b.group_id) || a.pattern.localeCompare(b.pattern),
    )
  }

  addGroupRule(
    groupId: string,
    pattern: string,
    actor: User,
  ): Result<components['schemas']['GroupRule']> {
    if (!validPattern(pattern))
      return badRequest(
        'pattern must contain 1 to 128 characters from A-Z, a-z, 0-9, ., _, -, * and ?',
      )
    if (!this.groups.some((g) => g.id === groupId)) return notFound()
    const rules = this.groupRules.filter((r) => r.group_id === groupId)
    if (rules.some((r) => r.pattern.toLowerCase() === pattern.toLowerCase()))
      return fail(409, 'pattern_taken', 'pattern already exists in this group')
    if (rules.length >= 20) return badRequest('pattern: a group can have at most 20 patterns')
    const rule = {
      id: this.rng.uuid(),
      group_id: groupId,
      pattern,
      created_at: iso(this.now()),
      created_by: { id: actor.id, display_name: actor.display_name },
    }
    this.groupRules.push(rule)
    this.record(actor, 'group.rule_added', 'group', groupId, { pattern })
    this.emit({ type: 'group_rules.updated' })
    return ok(rule)
  }

  removeGroupRule(groupId: string, ruleId: string, actor: User): Result<null> {
    const rule = this.groupRules.find((r) => r.id === ruleId && r.group_id === groupId)
    if (!rule) return notFound()
    this.groupRules = this.groupRules.filter((r) => r.id !== ruleId)
    const conflicts = this.reevaluateGroupConflicts(groupId, (hostname) =>
      this.groupRules.some(
        (remaining) => remaining.group_id === groupId && matchHostname(remaining.pattern, hostname),
      ),
    )
    this.record(actor, 'group.rule_removed', 'group', groupId, {
      pattern: rule.pattern,
      ...(conflicts.updated.length ? { conflicts_updated: conflicts.updated } : {}),
      ...(conflicts.resolved.length ? { conflicts_resolved: conflicts.resolved } : {}),
    })
    this.emit({ type: 'group_rules.updated' })
    return ok(null)
  }

  private reevaluateGroupConflicts(
    groupId: string,
    keepGroup: (hostname: string) => boolean,
  ): { updated: string[]; resolved: string[] } {
    const result = { updated: [] as string[], resolved: [] as string[] }
    for (const row of this.deviceRows) {
      const alert = row.open_alerts.find((candidate) => candidate.kind === 'group_conflict')
      if (!alert || !alert.groups.some((group) => group.id === groupId) || keepGroup(row.hostname))
        continue
      const remaining = alert.groups.filter((group) => group.id !== groupId)
      if (remaining.length < 2) {
        row.open_alerts = row.open_alerts.filter((candidate) => candidate.id !== alert.id)
        result.resolved.push(row.id)
      } else {
        alert.groups = remaining
        result.updated.push(row.id)
      }
      this.emit({ type: 'device.updated', device_id: row.id })
    }
    return result
  }

  previewGroupRule(
    groupId: string,
    pattern: string,
  ): Result<components['schemas']['GroupRulePreview']> {
    if (!validPattern(pattern))
      return badRequest(
        'pattern must contain 1 to 128 characters from A-Z, a-z, 0-9, ., _, -, * and ?',
      )
    if (!this.groups.some((g) => g.id === groupId)) return notFound()
    const matches: components['schemas']['RuleDeviceRef'][] = this.deviceRows
      .filter((d) => d.state === 'pending' || d.state === 'approved')
      .filter((d) => matchHostname(pattern, d.hostname))
      .sort((a, b) => a.hostname.localeCompare(b.hostname) || a.id.localeCompare(b.id))
      .map(({ id, rustdesk_id, hostname, alias, state, group_id }) => ({
        id,
        rustdesk_id,
        hostname,
        alias,
        state: state as 'pending' | 'approved',
        group_id,
      }))
    const conflicts = matches.flatMap((device) => {
      const ids = [...new Set([...this.ruleCandidates(device.hostname), groupId])].sort()
      return ids.length > 1
        ? [
            {
              device,
              groups: ids.flatMap((id) =>
                this.groups.filter((g) => g.id === id).map(({ id, name }) => ({ id, name })),
              ),
            },
          ]
        : []
    })
    return ok({
      match_count: matches.length,
      matches: matches.slice(0, 200),
      conflict_count: conflicts.length,
      conflicts: conflicts.slice(0, 200),
    })
  }

  // ---- tags ---------------------------------------------------------------

  /** Tags by name; with `deviceIds`, only those on at least one of those devices. */
  sortedTags(deviceIds?: ReadonlySet<string>): Tag[] {
    const used = deviceIds
      ? new Set(this.deviceRows.filter((d) => deviceIds.has(d.id)).flatMap((d) => d.tag_ids))
      : null
    return this.tags
      .filter((t) => !used || used.has(t.id))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  private tagTaken(name: string, exceptId?: string): boolean {
    return this.tags.some((t) => t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase())
  }

  createTag(name: string, color: number, actor: User): Result<Tag> {
    if (name.trim() === '') return badRequest('name must not be blank')
    if (this.tagTaken(name)) return fail(409, 'name_taken', 'a tag has this name')
    const tag: Tag = { id: this.newId(), name, color }
    this.tags.push(tag)
    this.record(actor, 'tag.created', 'tag', tag.id, { name, color })
    return ok(tag)
  }

  updateTag(id: string, patch: { name?: string; color?: number }, actor: User): Result<Tag> {
    const tag = this.tags.find((t) => t.id === id)
    if (!tag) return notFound('tag not found')
    if (patch.name !== undefined) {
      if (patch.name.trim() === '') return badRequest('name must not be blank')
      if (this.tagTaken(patch.name, id)) return fail(409, 'name_taken', 'another tag has this name')
    }
    const before = { name: tag.name, color: tag.color }
    if (patch.name !== undefined) tag.name = patch.name
    if (patch.color !== undefined) tag.color = patch.color
    this.record(actor, 'tag.updated', 'tag', id, {
      before,
      after: { name: tag.name, color: tag.color },
    })
    return ok({ ...tag })
  }

  deleteTag(id: string, actor: User): Result<null> {
    const tag = this.tags.find((t) => t.id === id)
    if (!tag) return notFound('tag not found')
    this.tags = this.tags.filter((t) => t.id !== id)
    for (const d of this.deviceRows) {
      if (d.tag_ids.includes(id)) {
        d.tag_ids = d.tag_ids.filter((t) => t !== id)
        this.emit({ type: 'device.updated', device_id: d.id })
      }
    }
    this.record(actor, 'tag.deleted', 'tag', id, { name: tag.name })
    return ok(null)
  }

  // ---- sessions -----------------------------------------------------------

  sessionView(row: SessionRow): RemoteSession {
    const device = this.deviceRows.find((d) => d.id === row.device_id)
    const end = row.ended_at ? Date.parse(row.ended_at) : this.now()
    return {
      id: row.id,
      device_id: row.device_id,
      peer_rustdesk_id: row.peer_rustdesk_id,
      peer_name: row.peer_name,
      type: row.type,
      client_ip: row.client_ip,
      started_at: row.started_at,
      authed_at: row.authed_at,
      ended_at: row.ended_at,
      end_reason: row.end_reason,
      disconnect_requested_at: row.disconnect_requested_at,
      device_name: device ? this.deviceName(device) : '',
      rustdesk_id: device?.rustdesk_id ?? '',
      duration_seconds: Math.max(0, Math.floor((end - Date.parse(row.started_at)) / 1000)),
    }
  }

  /** Stores the request once; a repeat keeps the first time and adds no audit entry. */
  requestDisconnect(id: string, actor: User): Result<RemoteSession> {
    const row = this.sessionRows.find((s) => s.id === id)
    if (!row) return notFound('session not found')
    if (row.ended_at !== null) return fail(409, 'session_ended', 'the session has already ended')
    if (row.disconnect_requested_at === null) {
      row.disconnect_requested_at = iso(this.now())
      this.emit({ type: 'session.updated', session_id: row.id, device_id: row.device_id })
      this.record(actor, 'session.disconnect_requested', 'session', row.id, {
        device_id: row.device_id,
        conn_id: row.conn_id,
      })
    }
    return ok(this.sessionView(row))
  }

  // ---- preferences --------------------------------------------------------

  preferencesFor(userId: string): Preferences {
    let stored = this.preferences.get(userId)
    if (!stored && this.preferencesStore) {
      try {
        const raw = this.preferencesStore.getItem(PREFERENCES_KEY + userId)
        if (raw) {
          stored = JSON.parse(raw) as Preferences
          this.preferences.set(userId, stored)
        }
      } catch {
        // Junk or blocked storage: the defaults below.
      }
    }
    if (!stored) stored = presetPreferences('business')

    const palette = [
      'ferricade',
      'indigo',
      'graphite',
      'ocean',
      'violet',
      'moss',
      'sandstone',
    ].includes((stored as Preferences & { palette?: string }).palette ?? '')
      ? (stored as Preferences).palette
      : 'ferricade'

    const toastSeconds = [0, 3, 5, 10, 30].includes(
      (stored as Preferences & { toast_seconds?: number }).toast_seconds ?? -1,
    )
      ? (stored as Preferences).toast_seconds
      : 5

    const known = new Set(stored.modules.map((m) => m.id))
    // A User keeps pins only for devices they can see: a hidden device answers
    // like an unknown one (prefs.go livePins).
    const scoped = this.users.find((u) => u.id === userId)?.role === 'user'
    const visible = scoped ? this.visibleDeviceIds(userId) : null
    const approved = new Set(
      this.deviceRows
        .filter((d) => d.state === 'approved' && (!visible || visible.has(d.id)))
        .map((d) => d.id),
    )
    return {
      ...stored,
      palette,
      toast_seconds: toastSeconds,
      // As normalizeModules in internal/adminapi/prefs.go: a missing or no
      // longer offered size becomes the module's default.
      modules: [
        ...stored.modules.map((m) => ({
          ...m,
          size: offersSize(m.id, m.size ?? '')
            ? m.size
            : CATALOG.modules.find((c) => c.id === m.id)!.default_size,
        })),
        ...CATALOG.modules
          .filter((m) => !known.has(m.id))
          .map((m) => ({ id: m.id, enabled: false, size: m.default_size })),
      ],
      pinned_device_ids: stored.pinned_device_ids.filter((id) => approved.has(id)),
    }
  }

  savePreferences(userId: string, prefs: Preferences): Preferences {
    this.preferences.set(userId, prefs)
    try {
      this.preferencesStore?.setItem(PREFERENCES_KEY + userId, JSON.stringify(prefs))
    } catch {
      // Full or blocked storage: kept in memory only.
    }
    this.emit({ type: 'preferences.updated', user_id: userId })
    return this.preferencesFor(userId)
  }

  // ---- setup --------------------------------------------------------------

  /** Puts the mock in the state of a fresh install: no users, no server, setup open. */
  beginSetup(): void {
    this.users = []
    this.grants.clear()
    this.passwords.clear()
    this.totpEnrolled.clear()
    this.server = null
    this.setup = {
      complete: false,
      ownerCreated: false,
      totpGenerated: false,
      totpVerified: false,
      serverSaved: false,
    }
  }
}

export function createMockDB(size: MockSize, options?: MockDBOptions): MockDB {
  return new MockDB(size, options)
}
