// Which cached queries each live event makes stale. This map is the one place
// that ties the event stream to query keys: pages key their queries with
// src/lib/queryKeys.ts, and the events below reach them.
import type { QueryKey } from '@tanstack/react-query'
import type { components } from '../api/schema'
import { queryKeys } from '../lib/queryKeys'

/** The data of one /events message (the contract's LiveEvent). */
export type LiveEvent = components['schemas']['LiveEvent']
export type LiveEventType = LiveEvent['type']

type Invalidation = (event: LiveEvent) => readonly QueryKey[] | 'all'

const deviceKeys = (e: LiveEvent): QueryKey[] => [
  queryKeys.devices.all(),
  queryKeys.summary(),
  queryKeys.fleetMap(),
  // An event without an id (none today) refreshes every device detail.
  queryKeys.device(e.device_id),
  // Session lists and statistics show device names and aliases.
  queryKeys.sessions.all(),
  queryKeys.sessionStats(),
]
const device: Invalidation = deviceKeys
const session: Invalidation = () => [
  queryKeys.sessions.all(),
  queryKeys.summary(),
  queryKeys.sessionStats(),
]
const idAllowList: Invalidation = () => [
  queryKeys.settingsIDAllowList(),
  ['groups'],
  queryKeys.device(),
]

/**
 * The queries to invalidate for each event type; "all" for every query. Its
 * keys are the contract's event types: TypeScript rejects a missing type and a
 * type the contract does not have.
 */
export const LIVE_INVALIDATIONS = {
  'device.updated': device,
  'device.enrolled': device,
  // The server leaves deleted devices out of pinned_device_ids, so the pins too.
  'device.deleted': (e) => [...deviceKeys(e), queryKeys.preferences()],
  'device.online': device,
  'device.offline': device,
  'session.started': session,
  'session.updated': session,
  'session.ended': session,
  'audit.created': () => [queryKeys.audit.all()],
  'preferences.updated': () => [queryKeys.preferences()],
  'group_rules.updated': () => [queryKeys.groupRules()],
  'id_allow_list.updated': idAllowList,
  // The server may have dropped events, and ends the stream after this one.
  resync: () => 'all',
} as const satisfies { [T in LiveEventType]: Invalidation }

/** Every event type of the stream (the message's `event:` name). */
export const LIVE_EVENT_TYPES = Object.keys(LIVE_INVALIDATIONS) as LiveEventType[]

/**
 * The roots of the queries that live events keep fresh. While the stream is
 * down they are refetched on a timer instead.
 */
export const LIVE_QUERY_ROOTS: ReadonlySet<unknown> = new Set([
  queryKeys.devices.all()[0],
  queryKeys.device()[0],
  queryKeys.summary()[0],
  queryKeys.fleetMap()[0],
  queryKeys.sessions.all()[0],
  queryKeys.sessionStats()[0],
  queryKeys.audit.all()[0],
  queryKeys.preferences()[0],
  queryKeys.groupRules()[0],
  queryKeys.settingsIDAllowList()[0],
  queryKeys.groups()[0],
])

export function isLiveQueryKey(key: QueryKey): boolean {
  return LIVE_QUERY_ROOTS.has(key[0])
}

/** The LiveEvent in a message's data, or null when it is not one of `type`. */
export function parseLiveEvent(type: string, data: unknown): LiveEvent | null {
  if (typeof data !== 'string') return null
  let event: unknown
  try {
    event = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof event !== 'object' || event === null || !('type' in event)) return null
  if (event.type !== type || !(LIVE_EVENT_TYPES as string[]).includes(type)) return null
  return event as LiveEvent
}
