import type { MockSize } from '../config'
import { DAY, MINUTE, iso, type Rng } from './rng'
import type { AuditEvent, DeviceRow, User } from './types'

const EXTRA: Record<MockSize, number> = { small: 6, medium: 70, large: 400 }
const ADMIN_IP = '192.168.1.20'

type Draft = Omit<AuditEvent, 'id' | 'at'> & { at: number }

/** The audit log, newest first. Actions and details follow what the backend writes. */
export function createAudit(
  size: MockSize,
  rng: Rng,
  now: number,
  devices: DeviceRow[],
  users: User[],
): AuditEvent[] {
  const drafts: Draft[] = []
  const actors = users.filter((u) => u.status === 'active')
  const owner = users[0]!
  const device = (d: DeviceRow, at: number, action: string, actor: User | null, details = {}) =>
    drafts.push({
      at,
      actor_user_id: actor?.id ?? null,
      actor_ip: actor ? ADMIN_IP : '203.0.113.' + rng.int(2, 250),
      action,
      target_type: 'device',
      target_id: d.id,
      details,
    })

  drafts.push(
    {
      at: now - 120 * DAY,
      actor_user_id: null,
      actor_ip: ADMIN_IP,
      action: 'setup.owner_created',
      target_type: 'user',
      target_id: owner.id,
      details: {},
    },
    {
      at: now - 120 * DAY + 5 * MINUTE,
      actor_user_id: null,
      actor_ip: ADMIN_IP,
      action: 'setup.completed',
      target_type: 'server',
      target_id: 'default',
      details: {},
    },
  )

  for (const d of devices) {
    const first = Date.parse(d.first_seen_at)
    device(d, first, 'device.enrolled', null, { rustdesk_id: d.rustdesk_id })
    if (d.approved_at) {
      const actor = users.find((u) => u.id === d.approved_by) ?? owner
      device(d, Date.parse(d.approved_at), 'device.approved', actor)
      if (d.state === 'archived') {
        device(d, Date.parse(d.updated_at), 'device.archived', actor)
      }
    } else if (d.state === 'rejected') {
      device(d, first + 30 * MINUTE, 'device.rejected', owner)
    }
  }

  const approved = devices.filter((d) => d.state === 'approved')
  const known = approved.length ? approved : devices
  for (let i = 0; i < EXTRA[size]; i++) {
    const at = now - rng.int(1, 60 * 24 * 14) * MINUTE * (i % 3 === 0 ? 6 : 1)
    const actor = rng.pick(actors)
    const d = rng.pick(known)
    switch (rng.int(0, 7)) {
      case 0:
        device(d, at, 'device.updated', actor, {
          before: { alias: '' },
          after: { alias: d.alias || 'Front desk' },
        })
        break
      case 1:
      case 2:
        device(d, at, 'device.connect_link', actor, { action: 'connect', relay: false })
        break
      case 3:
        drafts.push({
          at,
          actor_user_id: actor.id,
          actor_ip: ADMIN_IP,
          action: 'auth.login',
          target_type: 'user',
          target_id: actor.id,
          details: {},
        })
        break
      case 4:
        drafts.push({
          at,
          actor_user_id: null,
          actor_ip: '198.51.100.' + rng.int(2, 250),
          action: 'auth.login_failed',
          target_type: 'user',
          target_id: rng.pick(['admin', 'alex', 'root', 'sam']),
          details: {},
        })
        break
      case 5:
        drafts.push({
          at,
          actor_user_id: actor.id,
          actor_ip: ADMIN_IP,
          action: 'auth.mfa_passed',
          target_type: 'user',
          target_id: actor.id,
          details: {},
        })
        break
      case 6:
        drafts.push({
          at,
          actor_user_id: owner.id,
          actor_ip: ADMIN_IP,
          action: 'tag.created',
          target_type: 'tag',
          target_id: rng.uuid(),
          details: { name: rng.pick(['spare', 'vip', 'loaner']) },
        })
        break
      default:
        drafts.push({
          at,
          actor_user_id: owner.id,
          actor_ip: ADMIN_IP,
          action: 'user.updated',
          target_type: 'user',
          target_id: rng.pick(users).id,
          details: { before: { display_name: 'Sam' }, after: { display_name: 'Sam Okafor' } },
        })
    }
  }

  return drafts
    .filter((e) => e.at <= now)
    .sort((a, b) => b.at - a.at)
    .map(({ at, ...e }) => ({ id: rng.uuid(), at: iso(at), ...e }))
}
