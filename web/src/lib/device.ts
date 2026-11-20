// How the UI names a device and summarises its status, in one place: the
// devices table, the device panel, the palette and the dashboard modules all
// show the same name and the same status for the same device.
import type { components } from '@/api/schema'

type Device = components['schemas']['Device']

export type DeviceStatus = 'alert' | 'pending' | 'online' | 'offline'

/** The name an admin knows the device by: alias, then hostname, then RustDesk ID. */
export function deviceName(d: Pick<Device, 'alias' | 'hostname' | 'rustdesk_id'>): string {
  return d.alias || d.hostname || d.rustdesk_id
}

/** What needs attention first: an open alert, then pending approval, then online or not. */
export function deviceStatus(
  d: Pick<Device, 'state' | 'online'> & { open_alerts?: readonly unknown[] },
): DeviceStatus {
  if (d.open_alerts && d.open_alerts.length > 0) return 'alert'
  if (d.state === 'pending') return 'pending'
  return d.online ? 'online' : 'offline'
}

export const STATUS_LABEL: Record<DeviceStatus, string> = {
  alert: 'Alert',
  pending: 'Pending',
  online: 'Online',
  offline: 'Offline',
}
