// Every shape the mock stores or serves is spelled from the generated contract
// types, so a field the contract does not have cannot be added here.
import type { components } from '../../api/schema'

type S = components['schemas']
export type User = S['User']
export type Tag = S['Tag']
export type Alert = S['Alert']
export type Device = S['Device']
export type Group = S['Group']
export type Server = S['Server']
export type AuditEvent = S['AuditEvent']
export type RemoteSession = S['RemoteSession']
export type LiveEvent = S['LiveEvent']
export type DashboardThresholds = S['DashboardThresholds']
export type DashboardCatalog = S['DashboardCatalog']
export type Preferences = S['Preferences']
export type ClientConfig = S['ClientConfig']
export type Error = S['Error']

/** A device as stored: tags by id; online and conns are live state, worked out when read. */
export type DeviceRow = Omit<Device, 'tags' | 'online' | 'conns'> & { tag_ids: string[] }
/** A group as stored: the tree is built when it is read. */
export type GroupRow = Omit<Group, 'children'>
/** A remote session as stored: duration is worked out when it is read. */
export type SessionRow = Omit<RemoteSession, 'device_name' | 'duration_seconds' | 'rustdesk_id'> & {
  conn_id: number
}
export interface Snapshot {
  at: number
  approved: number
  online: number
  pending: number
  sessions: number
}
