import { describe, expect, it } from 'vitest'
import type { LiveEvent } from './invalidation'
import {
  isLiveQueryKey,
  LIVE_EVENT_TYPES,
  LIVE_INVALIDATIONS,
  LIVE_QUERY_ROOTS,
} from './invalidation'

const ID = '2b1f4a0e-6c41-4a39-9d7f-0a56a6f9a111'

describe('LIVE_INVALIDATIONS', () => {
  it('maps every event but resync to live query keys only', () => {
    expect(LIVE_INVALIDATIONS).toHaveProperty('group_rules.updated')
    expect(LIVE_INVALIDATIONS).toHaveProperty('id_allow_list.updated')
    for (const type of LIVE_EVENT_TYPES) {
      const event: LiveEvent = { type, device_id: ID, session_id: ID, audit_id: ID, user_id: ID }
      const keys = LIVE_INVALIDATIONS[type](event)
      if (type === 'resync') {
        expect(keys).toBe('all')
        continue
      }
      expect(keys, type).not.toBe('all')
      for (const key of keys as unknown[][]) expect(isLiveQueryKey(key), String(key)).toBe(true)
    }
  })

  it('invalidates every ID allow list scope after a list changes', () => {
    expect(LIVE_INVALIDATIONS['id_allow_list.updated']({ type: 'id_allow_list.updated' })).toEqual([
      ['settings', 'id-allow-list'],
      ['groups'],
      ['device'],
    ])
  })

  it('invalidates every device detail when a device event has no id', () => {
    expect(LIVE_INVALIDATIONS['device.updated']({ type: 'device.updated' })).toContainEqual([
      'device',
    ])
  })

  it.each(['device.updated', 'device.enrolled', 'device.online', 'device.offline'] as const)(
    '%s also refreshes sessions and session stats (they show device names)',
    (type) => {
      const keys = LIVE_INVALIDATIONS[type]({ type, device_id: ID })
      expect(keys).toContainEqual(['sessions'])
      expect(keys).toContainEqual(['session-stats'])
    },
  )

  it('device.deleted refreshes the lists, the device, its sessions and the pins', () => {
    const keys = LIVE_INVALIDATIONS['device.deleted']({ type: 'device.deleted', device_id: ID })
    expect(keys).toContainEqual(['devices'])
    expect(keys).toContainEqual(['summary'])
    expect(keys).toContainEqual(['device', ID])
    expect(keys).toContainEqual(['sessions'])
    expect(keys).toContainEqual(['session-stats'])
    // The server leaves deleted devices out of pinned_device_ids.
    expect(keys).toContainEqual(['preferences'])
  })

  it('has live roots that are all reachable from some event', () => {
    const reached = new Set<unknown>()
    for (const type of LIVE_EVENT_TYPES) {
      const keys = LIVE_INVALIDATIONS[type]({ type, device_id: ID })
      if (keys !== 'all') for (const key of keys) reached.add(key[0])
    }
    expect([...reached].toSorted()).toEqual([...LIVE_QUERY_ROOTS].toSorted())
  })
})
