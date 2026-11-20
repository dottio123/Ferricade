import { describe, expect, it } from 'vitest'
import { deviceName, deviceStatus, STATUS_LABEL } from './device'

const base = {
  alias: '',
  hostname: '',
  rustdesk_id: '123456789',
  state: 'approved' as const,
  online: false,
  open_alerts: [] as { id: string }[],
}

describe('deviceName', () => {
  it('prefers the alias, then the hostname, then the RustDesk ID', () => {
    expect(deviceName({ ...base, alias: 'Front desk', hostname: 'pc-1' })).toBe('Front desk')
    expect(deviceName({ ...base, hostname: 'pc-1' })).toBe('pc-1')
    expect(deviceName(base)).toBe('123456789')
  })
})

describe('deviceStatus', () => {
  it('ranks an open alert over pending, then online over offline', () => {
    expect(deviceStatus({ ...base, open_alerts: [{ id: 'a' }], state: 'pending' })).toBe('alert')
    expect(deviceStatus({ ...base, state: 'pending', online: true })).toBe('pending')
    expect(deviceStatus({ ...base, online: true })).toBe('online')
    expect(deviceStatus(base)).toBe('offline')
  })

  it('has a label for every status', () => {
    expect(STATUS_LABEL).toEqual({
      alert: 'Alert',
      pending: 'Pending',
      online: 'Online',
      offline: 'Offline',
    })
  })
})
