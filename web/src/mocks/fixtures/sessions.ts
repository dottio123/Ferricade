import type { MockSize } from '../config'
import { DAY, MINUTE, iso, type Rng } from './rng'
import type { DeviceRow, SessionRow } from './types'

const COUNTS: Record<MockSize, { history: number; open: number }> = {
  small: { history: 12, open: 1 },
  medium: { history: 260, open: 4 },
  large: { history: 2500, open: 25 },
}
const PEERS = [
  'mbp-alex',
  'sam-laptop',
  'iPhone-13',
  'helpdesk-01',
  'jordan-pc',
  'pixel-8',
  'ipad-air',
]
const TYPES: Array<{ type: SessionRow['type']; weight: number }> = [
  { type: 'remote', weight: 72 },
  { type: 'file_transfer', weight: 14 },
  { type: 'terminal', weight: 6 },
  { type: 'port_forward', weight: 4 },
  { type: 'camera', weight: 4 },
]

function pickType(rng: Rng): SessionRow['type'] {
  let r = rng.next() * 100
  for (const t of TYPES) if ((r -= t.weight) < 0) return t.type
  return 'remote'
}

/** Working hours are busier; weekends are quiet. Returns a start time within the last `days`. */
function startTime(rng: Rng, now: number, days: number): number {
  for (;;) {
    const t = now - rng.next() * days * DAY
    const d = new Date(t)
    const hour = d.getUTCHours()
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6
    const p = (hour >= 8 && hour < 18 ? 1 : 0.15) * (weekend ? 0.25 : 1)
    if (rng.next() < p) return t
  }
}

/** Newest start first, as GET /sessions lists them. Conn ids are unique per device. */
export function createSessions(
  size: MockSize,
  rng: Rng,
  now: number,
  devices: DeviceRow[],
  online: Set<string>,
): SessionRow[] {
  const approved = devices.filter((d) => d.state === 'approved')
  if (approved.length === 0) return []
  const rows: SessionRow[] = []
  let conn = 1000

  const peer = () => ({
    peer_rustdesk_id: String(rng.int(100_000_000, 999_999_999)),
    peer_name: rng.pick(PEERS),
    client_ip: `192.168.1.${rng.int(2, 250)}`,
  })

  // A few heavy users, so "most-used devices" has a clear order.
  const heavy = approved.slice(0, Math.max(1, Math.ceil(approved.length / 6)))
  for (let i = 0; i < COUNTS[size].history; i++) {
    const device = rng.chance(0.5) ? rng.pick(heavy) : rng.pick(approved)
    const started = startTime(rng, now - 2 * MINUTE, 45)
    if (rng.chance(0.06)) {
      // A connection attempt whose peer never authenticated.
      rows.push({
        id: rng.uuid(),
        device_id: device.id,
        conn_id: conn++,
        peer_rustdesk_id: '',
        peer_name: '',
        type: 'unknown',
        client_ip: `198.51.100.${rng.int(2, 250)}`,
        started_at: iso(started),
        authed_at: null,
        ended_at: iso(started + rng.int(4, 30) * 1000),
        end_reason: 'closed',
        disconnect_requested_at: null,
      })
      continue
    }
    const authed = started + rng.int(1, 4) * 1000
    const minutes = Math.round(2 ** (rng.next() * 6.5)) // 1 to ~90, mostly short
    rows.push({
      id: rng.uuid(),
      device_id: device.id,
      conn_id: conn++,
      ...peer(),
      type: pickType(rng),
      started_at: iso(started),
      authed_at: iso(authed),
      ended_at: iso(Math.min(authed + minutes * MINUTE, now - MINUTE)),
      end_reason: rng.chance(0.05) ? 'stale' : 'closed',
      disconnect_requested_at: null,
    })
  }

  // Open sessions on online approved devices.
  const live = approved.filter((d) => online.has(d.id))
  for (const [index, device] of live.slice(0, COUNTS[size].open).entries()) {
    // The first open session (the one with the long peer ID) is always the newest, so
    // every list and every small card shows it first. startTime() above draws a
    // clock-dependent number of values, so a drawn offset cannot promise that. The
    // draw is kept so the values after it do not change.
    const drawn = rng.int(1, 45)
    const started = now - (index === 0 ? 1 : drawn) * MINUTE
    rows.push({
      id: rng.uuid(),
      device_id: device.id,
      conn_id: conn++,
      ...peer(),
      ...(index === 0 ? { peer_rustdesk_id: '34500423@198.51.100.152:21116' } : {}),
      type: pickType(rng),
      started_at: iso(started),
      authed_at: iso(started + 2000),
      ended_at: null,
      end_reason: null,
      disconnect_requested_at: null,
    })
  }
  return rows.sort((a, b) => b.started_at.localeCompare(a.started_at))
}
