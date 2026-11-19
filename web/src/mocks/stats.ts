// Derived numbers: the dashboard summary, session statistics and trend history,
// worked out from the mock's state the way the backend works them out from
// Postgres (see docs/phase-1b-backend-notes.md: only authenticated sessions
// count; per_day buckets by the day a session started).
import type { components } from '../api/schema'
import type { MockDB } from './db'
import { DAY } from './fixtures/rng'

type S = components['schemas']
type Attention = S['FleetSummary']['attention'][number]

/** Tests may lower this to exercise truncation without a 2000-row fixture. */
export const fleetMapLimit = 2000

export function fleetMap(db: MockDB, scope?: Scope, limit = fleetMapLimit): S['FleetMap'] {
  const visible = scope?.devices
  const devices = db.deviceRows
    .filter((d) => d.state === 'approved' && (!visible || visible.has(d.id)))
    .map((d) => ({
      id: d.id,
      name: db.deviceName(d),
      group_id: d.group_id !== null && scope && !scope.groups.has(d.group_id) ? null : d.group_id,
      status:
        d.open_alerts.length > 0
          ? ('alert' as const)
          : db.online.has(d.id)
            ? ('online' as const)
            : ('offline' as const),
    }))
    .sort(
      (a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id),
    )
  const truncated = devices.length > limit
  return {
    generated_at: new Date(db.now()).toISOString(),
    truncated,
    devices: devices.slice(0, limit),
  }
}

const LINUX_DISTRIBUTIONS: Record<string, string> = {
  ubuntu: 'Ubuntu',
  debian: 'Debian',
  fedora: 'Fedora',
  centos: 'CentOS',
  rhel: 'RHEL',
  rocky: 'Rocky Linux',
  almalinux: 'AlmaLinux',
  arch: 'Arch Linux',
  manjaro: 'Manjaro',
  linuxmint: 'Linux Mint',
  opensuse: 'openSUSE',
  'opensuse-leap': 'openSUSE',
  'opensuse-tumbleweed': 'openSUSE',
  sles: 'SLES',
  pop: 'Pop!_OS',
  elementary: 'elementary OS',
  kali: 'Kali Linux',
  raspbian: 'Raspberry Pi OS',
  alpine: 'Alpine Linux',
  nixos: 'NixOS',
  gentoo: 'Gentoo',
  zorin: 'Zorin OS',
  endeavouros: 'EndeavourOS',
  deepin: 'deepin',
  kylin: 'Kylin',
  uos: 'UOS',
}

function osName(raw: string): string {
  const id = raw.split(' / ')[0]!.trim().toLowerCase()
  if (id === 'windows') return 'Windows'
  if (id === 'macos') return 'macOS'
  if (id === 'android') return 'Android'
  if (id === 'linux') return 'Linux'
  if (!id || id === 'unknown') return 'Other'
  return LINUX_DISTRIBUTIONS[id] ?? id[0]!.toUpperCase() + id.slice(1)
}

/** Dotted numeric versions, part by part; a missing or non-numeric part is 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? 0) || 0
    const y = Number(pb[i] ?? 0) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

const KIND_ORDER: Record<Attention['kind'], number> = {
  uuid_mismatch: 0,
  access_window_unconfirmed: 1,
  group_conflict: 2,
  pending_long: 3,
  offline_long: 4,
  outdated_client: 5,
}

/** A User's view: the devices and groups they may see. */
export interface Scope {
  devices: ReadonlySet<string>
  groups: ReadonlySet<string>
}

/** With `scope`, everything is worked out over those devices and groups only. */
export function summary(db: MockDB, scope?: Scope): S['FleetSummary'] {
  const visible = scope?.devices
  const now = db.now()
  const th = db.thresholds
  const counts = { approved: 0, pending: 0, rejected: 0, archived: 0, online: 0 }
  const os = new Map<string, number>()
  const versions = new Map<string, number>()
  const groupTally = new Map<string | null, { online: number; total: number }>()
  const attention: Attention[] = []
  let openAlerts = 0

  for (const d of db.deviceRows) {
    if (visible && !visible.has(d.id)) continue
    const name = db.deviceName(d)
    for (const a of d.open_alerts) {
      openAlerts++
      if (a.kind === 'group_conflict' && d.state !== 'approved') continue
      attention.push({
        kind: a.kind,
        device_id: d.id,
        rustdesk_id: d.rustdesk_id,
        name,
        since: a.created_at,
        detail:
          a.kind === 'uuid_mismatch'
            ? 'A client with a different UUID is using this ID'
            : a.kind === 'group_conflict'
              ? db.groups
                  .filter(
                    (g) =>
                      a.groups.some((ref) => ref.id === g.id) && (!scope || scope.groups.has(g.id)),
                  )
                  .map((g) => g.name)
                  .sort()
                  .join(', ')
              : 'Access window close is not confirmed by the device',
      })
    }
    counts[d.state]++
    if (d.state === 'pending') {
      if (now - Date.parse(d.first_seen_at) > th.pending_hours * 3_600_000) {
        attention.push({
          kind: 'pending_long',
          device_id: d.id,
          rustdesk_id: d.rustdesk_id,
          name,
          since: d.first_seen_at,
          detail: `Waiting for approval for over ${th.pending_hours} hours`,
        })
      }
      continue
    }
    if (d.state !== 'approved') continue

    const online = db.online.has(d.id)
    if (online) counts.online++
    const platform = osName(d.os)
    os.set(platform, (os.get(platform) ?? 0) + 1)
    const version = d.client_version || 'unknown'
    versions.set(version, (versions.get(version) ?? 0) + 1)
    const tally = groupTally.get(d.group_id) ?? { online: 0, total: 0 }
    tally.total++
    if (online) tally.online++
    groupTally.set(d.group_id, tally)

    if (!online && now - Date.parse(d.last_seen_at) > th.offline_days * DAY) {
      attention.push({
        kind: 'offline_long',
        device_id: d.id,
        rustdesk_id: d.rustdesk_id,
        name,
        since: d.last_seen_at,
        detail: `Not seen for over ${th.offline_days} days`,
      })
    }
    if (
      th.min_client_version &&
      d.client_version &&
      compareVersions(d.client_version, th.min_client_version) < 0
    ) {
      attention.push({
        kind: 'outdated_client',
        device_id: d.id,
        rustdesk_id: d.rustdesk_id,
        name,
        since: d.first_seen_at,
        detail: `Client ${d.client_version} is older than ${th.min_client_version}`,
      })
    }
  }

  const groups: S['FleetSummary']['groups'] = [...db.groups]
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .filter((g) => !scope || scope.groups.has(g.id))
    .map((g) => ({ id: g.id, name: g.name, ...(groupTally.get(g.id) ?? { online: 0, total: 0 }) }))
  const ungrouped = groupTally.get(null)
  if (ungrouped) groups.push({ id: null, name: 'Ungrouped', ...ungrouped })

  return {
    generated_at: new Date(now).toISOString(),
    devices: counts,
    sessions: {
      active: db.sessionRows.filter(
        (s) =>
          s.ended_at === null &&
          s.authed_at !== null &&
          (!visible || visible.has(s.device_id)) &&
          db.deviceRows.find((d) => d.id === s.device_id)?.state === 'approved',
      ).length,
    },
    alerts: { open: openAlerts },
    os: [...os]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) =>
        a.name === 'Other'
          ? 1
          : b.name === 'Other'
            ? -1
            : b.count - a.count || a.name.localeCompare(b.name),
      ),
    versions: [...versions]
      .map(([version, count]) => ({
        version,
        count,
        outdated:
          th.min_client_version !== '' &&
          version !== 'unknown' &&
          compareVersions(version, th.min_client_version) < 0,
      }))
      .sort((a, b) => {
        if ((a.version === 'unknown') !== (b.version === 'unknown'))
          return a.version === 'unknown' ? 1 : -1
        return compareVersions(b.version, a.version) || a.version.localeCompare(b.version)
      }),
    groups,
    attention: attention
      .sort(
        (a, b) =>
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
          a.since.localeCompare(b.since) ||
          a.rustdesk_id.localeCompare(b.rustdesk_id),
      )
      .slice(0, 50),
  }
}

/** The calendar day (YYYY-MM-DD) of an instant in a time zone; throws RangeError for an unknown zone. */
function dayIn(timeZone: string, ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms)
}

export function isTimeZone(tz: string): boolean {
  try {
    dayIn(tz, 0)
    return true
  } catch {
    return false
  }
}

export function sessionStats(
  db: MockDB,
  range: '7d' | '30d',
  tz: string,
  visible?: ReadonlySet<string>,
): S['SessionStats'] {
  const now = db.now()
  const days = range === '7d' ? 7 : 30
  const labels = Array.from({ length: days }, (_, i) => dayIn(tz, now - (days - 1 - i) * DAY))
  const perDay = new Map(labels.map((d) => [d, { day: d, count: 0, total_seconds: 0 }]))
  const perDevice = new Map<string, { count: number; total_seconds: number }>()
  let total = 0
  let count = 0

  for (const row of db.sessionRows) {
    if (row.authed_at === null) continue
    if (visible && !visible.has(row.device_id)) continue
    const bucket = perDay.get(dayIn(tz, Date.parse(row.started_at)))
    if (!bucket) continue
    const seconds = db.sessionView(row).duration_seconds
    bucket.count++
    bucket.total_seconds += seconds
    total += seconds
    count++
    const dev = perDevice.get(row.device_id) ?? { count: 0, total_seconds: 0 }
    dev.count++
    dev.total_seconds += seconds
    perDevice.set(row.device_id, dev)
  }

  return {
    range,
    tz,
    per_day: labels.map((d) => perDay.get(d)!),
    average_seconds: count ? Math.round(total / count) : 0,
    top_devices: [...perDevice]
      .sort((a, b) => b[1].total_seconds - a[1].total_seconds)
      .slice(0, 5)
      .map(([device_id, v]) => {
        const row = db.deviceRows.find((d) => d.id === device_id)
        return { device_id, device_name: row ? db.deviceName(row) : '', ...v }
      }),
  }
}

const HISTORY: Record<
  S['FleetHistory']['range'],
  { ms: number; step: S['FleetHistory']['step_seconds'] }
> = {
  '24h': { ms: DAY, step: 300 },
  '7d': { ms: 7 * DAY, step: 3600 },
  '30d': { ms: 30 * DAY, step: 21600 },
}

export function isHistoryRange(r: string | null): r is S['FleetHistory']['range'] {
  return r === '24h' || r === '7d' || r === '30d'
}

export function history(db: MockDB, range: S['FleetHistory']['range']): S['FleetHistory'] {
  const { ms, step } = HISTORY[range]
  const stepMs = step * 1000
  const since = db.now() - ms
  const buckets = new Map<
    number,
    { n: number; approved: number; online: number; pending: number; sessions: number }
  >()
  for (const s of db.snapshots) {
    if (s.at < since) continue
    const key = Math.floor(s.at / stepMs) * stepMs
    const b = buckets.get(key) ?? { n: 0, approved: 0, online: 0, pending: 0, sessions: 0 }
    b.n++
    b.approved += s.approved
    b.online += s.online
    b.pending += s.pending
    b.sessions = Math.max(b.sessions, s.sessions)
    buckets.set(key, b)
  }
  return {
    range,
    step_seconds: step,
    points: [...buckets]
      .sort((a, b) => a[0] - b[0])
      .map(([at, b]) => ({
        at: new Date(at).toISOString(),
        approved: Math.round(b.approved / b.n),
        online: Math.round(b.online / b.n),
        pending: Math.round(b.pending / b.n),
        sessions: b.sessions,
      })),
  }
}
