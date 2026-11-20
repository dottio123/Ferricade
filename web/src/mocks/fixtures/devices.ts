import type { MockSize } from '../config'
import { ADMIN_ID, OWNER_ID } from './users'
import { DAY, MINUTE, iso, type Rng } from './rng'
import type { DeviceRow, GroupRow, Tag } from './types'

type State = DeviceRow['state']

const COUNTS: Record<MockSize, Record<State, number>> = {
  small: { approved: 2, pending: 1, rejected: 0, archived: 0 },
  medium: { approved: 28, pending: 6, rejected: 3, archived: 3 },
  large: { approved: 310, pending: 40, rejected: 20, archived: 30 },
}
const ALERTS: Record<MockSize, number> = { small: 0, medium: 3, large: 15 }

// What RustDesk reports as "os": "<platform> / <details>".
const PLATFORMS = [
  {
    os: 'Windows / Windows 11 Pro',
    weight: 40,
    cpu: 'Intel(R) Core(TM) i5-12400, 6/12 cores',
    memory: '15.8GB',
  },
  {
    os: 'Windows / Windows 10 Pro',
    weight: 18,
    cpu: 'Intel(R) Core(TM) i7-8700, 6/12 cores',
    memory: '31.9GB',
  },
  {
    os: 'ubuntu / Linux 24.04 Ubuntu 24.04 LTS',
    weight: 10,
    cpu: 'AMD Ryzen 5 5600G, 6/12 cores',
    memory: '15.5GB',
  },
  {
    os: 'debian / Linux 12 Debian 12',
    weight: 4,
    cpu: 'Intel(R) N100, 4/4 cores',
    memory: '7.6GB',
  },
  { os: 'macOS / 14.5.0', weight: 12, cpu: 'Apple M2, 8/8 cores', memory: '16.0GB' },
  {
    os: 'Android / Android 14',
    weight: 8,
    cpu: 'Qualcomm Snapdragon 8 Gen 2, 8/8 cores',
    memory: '7.4GB',
  },
  {
    os: 'FreeBSD / 14.1',
    weight: 2,
    cpu: 'Intel(R) Xeon(R) E-2278G, 8/16 cores',
    memory: '63.7GB',
  },
  {
    os: 'fedora / Linux 42 Fedora 42',
    weight: 4,
    cpu: 'AMD Ryzen 7 5700G, 8/16 cores',
    memory: '31.0GB',
  },
  { os: 'linux / Linux', weight: 2, cpu: 'Intel(R) Xeon(R) E-2278G, 8/16 cores', memory: '63.7GB' },
] as const
const REQUIRED_LINUX = ['ubuntu', 'debian', 'fedora', 'linux'].map((id) =>
  PLATFORMS.find((platform) => platform.os.startsWith(`${id} /`))!,
)

const HOSTS: Record<string, string[]> = {
  Windows: [
    'frontdesk-pc',
    'reception-pc',
    'accounting-03',
    'DESKTOP-7K2QJ1M',
    'LAPTOP-9F3A2B1',
    'hr-laptop',
    'warehouse-02',
    'conf-room-pc',
  ],
  Linux: [
    'plexbox',
    'ubuntu-nuc',
    'pi-garage',
    'nas-01',
    'build-agent',
    'grafana-host',
    'dev-workstation',
  ],
  macOS: ['mbp-alex', 'mac-mini-lab', 'imac-design', 'mbp-sam'],
  Android: ['pixel-8', 'galaxy-tab-s9', 'kiosk-tablet', 'scanner-01'],
  FreeBSD: ['pfsense-edge'],
}
const LOGIN_USERS = ['alex', 'sam', 'reception', 'lab', 'kiosk', 'jordan', 'admin', 'svc-remote']
const ALIASES = [
  'Front desk',
  'Plex server',
  'Garage Pi',
  'Boardroom',
  'Reception',
  'Alex laptop',
  'Design iMac',
]
const NOTES = [
  'Replaced the SSD in March.',
  'Do not reboot during backups.',
  'Spare key in the safe.',
]
const VERSIONS = [
  ['1.4.0', 50],
  ['1.3.9', 20],
  ['1.3.8', 14],
  ['1.3.7', 8],
  ['1.2.7', 5],
  ['', 3],
] as const

const weighted = <T extends { weight: number }>(rng: Rng, items: readonly T[]): T => {
  let r = rng.next() * items.reduce((n, i) => n + i.weight, 0)
  for (const item of items) if ((r -= item.weight) < 0) return item
  return items[0]!
}

// Pending devices wait from minutes to days, so the "pending too long" attention item shows up.
const PENDING_AGES_MIN = [5, 20, 180, 420, 1800, 3300]

/**
 * Builds the fleet and says which devices are online. Approved devices are
 * mostly online; a couple are long offline; some have a mismatching-uuid alert.
 */
export function createDevices(
  size: MockSize,
  rng: Rng,
  now: number,
  groups: GroupRow[],
  tags: Tag[],
): { devices: DeviceRow[]; online: Set<string> } {
  const counts = COUNTS[size]
  const devices: DeviceRow[] = []
  const online = new Set<string>()
  const usedIds = new Set<string>()
  const nameUse = new Map<string, number>()
  const leafGroups = groups.filter((g) => !groups.some((o) => o.parent_id === g.id))

  const rustdeskId = () => {
    let id: string
    do id = String(rng.int(100_000_000, 999_999_999))
    while (usedIds.has(id))
    usedIds.add(id)
    return id
  }

  const states = (Object.keys(counts) as State[]).flatMap((s) => Array<State>(counts[s]).fill(s))
  let longOffline = size === 'small' ? 0 : size === 'medium' ? 2 : 10
  let alerts = ALERTS[size]
  let pendingIndex = 0
  let seededLinux = 0

  const base64Uuid = (): string => btoa(rng.uuid().replace(/-/g, ''))

  for (const state of states) {
    const randomPlatform = weighted(rng, PLATFORMS)
    const platform =
      state === 'approved' && seededLinux < 4 ? REQUIRED_LINUX[seededLinux++]! : randomPlatform
    const reportedOS = platform.os.split(' / ')[0]!
    const family = ['ubuntu', 'debian', 'fedora', 'linux', 'centos'].includes(reportedOS)
      ? 'Linux'
      : reportedOS
    const base = rng.pick(HOSTS[family] ?? ['host'])
    const n = (nameUse.get(base) ?? 0) + 1
    nameUse.set(base, n)
    const hostname = n === 1 ? base : `${base}-${String(n).padStart(2, '0')}`

    let first = now - rng.int(10, 200) * DAY
    let lastSeen = now - rng.int(0, 25) * 1000
    let isOnline = false
    if (state === 'pending') {
      first =
        now - (PENDING_AGES_MIN[pendingIndex++ % PENDING_AGES_MIN.length]! + rng.int(0, 9)) * MINUTE
      isOnline = rng.chance(0.6)
      lastSeen = isOnline ? now - rng.int(0, 25) * 1000 : first + rng.int(0, 5) * MINUTE
    } else if (state === 'approved') {
      isOnline = rng.chance(0.7)
      if (!isOnline) {
        if (longOffline > 0) {
          longOffline--
          lastSeen = now - rng.int(8, 40) * DAY
        } else lastSeen = now - rng.int(10, 3000) * MINUTE
      }
    } else {
      lastSeen = now - rng.int(2, 60) * DAY
    }
    lastSeen = Math.max(lastSeen, first)

    const approver = rng.chance(0.7) ? OWNER_ID : ADMIN_ID
    const approvedAt =
      state === 'approved' || state === 'archived' ? first + rng.int(1, 600) * MINUTE : null
    const id = rng.uuid()
    const hasTag = rng.chance(0.4) && state !== 'pending'
    const version = weighted(
      rng,
      VERSIONS.map(([v, w]) => ({ v, weight: w })),
    ).v

    devices.push({
      id,
      rustdesk_id: rustdeskId(),
      uuid: base64Uuid(),
      state,
      alias: rng.chance(0.15) && state === 'approved' ? rng.pick(ALIASES) : '',
      hostname,
      os: platform.os,
      cpu: platform.cpu,
      memory: platform.memory,
      client_version: state === 'pending' && rng.chance(0.15) ? '' : version,
      username: rng.pick(LOGIN_USERS),
      note: rng.chance(0.1) ? rng.pick(NOTES) : '',
      group_id:
        state !== 'pending' && state !== 'rejected' && rng.chance(0.8) && leafGroups.length
          ? rng.pick(leafGroups).id
          : null,
      first_seen_at: iso(first),
      last_seen_at: iso(lastSeen),
      approved_by: approvedAt === null ? null : approver,
      approved_at: approvedAt === null ? null : iso(approvedAt),
      updated_at: iso(Math.max(lastSeen, approvedAt ?? 0)),
      tag_ids: hasTag && tags.length ? [rng.pick(tags).id] : [],
      open_alerts: [],
    })
    if (isOnline) online.add(id)
  }

  // Alerts go on online approved devices: someone else's client is using the ID.
  for (const d of devices) {
    if (alerts === 0) break
    if (d.state === 'approved' && online.has(d.id) && rng.chance(0.3)) {
      d.open_alerts.push({
        id: rng.uuid(),
        kind: 'uuid_mismatch',
        seen_uuid: base64Uuid(),
        window_closed_at: null,
        groups: [],
        ip: `203.0.113.${rng.int(2, 250)}`,
        created_at: iso(now - rng.int(5, 3000) * MINUTE),
      })
      alerts--
    }
  }
  // Make sure the requested number of alerts exists even if the dice were unkind.
  for (const d of devices) {
    if (alerts === 0) break
    if (d.state === 'approved' && d.open_alerts.length === 0) {
      d.open_alerts.push({
        id: rng.uuid(),
        kind: 'uuid_mismatch',
        seen_uuid: base64Uuid(),
        window_closed_at: null,
        groups: [],
        ip: `203.0.113.${rng.int(2, 250)}`,
        created_at: iso(now - rng.int(5, 3000) * MINUTE),
      })
      alerts--
    }
  }

  devices.sort((a, b) => a.rustdesk_id.localeCompare(b.rustdesk_id))
  // The fixtures promise at least one online approved device even in the smallest fleet.
  if (![...devices].some((d) => d.state === 'approved' && online.has(d.id))) {
    const first = devices.find((d) => d.state === 'approved')
    if (first) online.add(first.id)
  }
  return { devices, online }
}
