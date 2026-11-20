// Controls for the Playwright flows: what a test does to the "server" while the
// app runs (the session ends, the stream drops, another admin changes a
// device). browser.ts puts them on window.__ferricadeMock; only the mock build
// and the dev server have them.
import type { Env, MockHealthCheck } from './route'

export interface MockControls {
  /** Ends the session, as 12 h idle or a disabled account would: the next call answers 401. */
  expireSession(): void
  /**
   * Ends every open event stream; new ones wait `ms` before they open (a server
   * restarting). Returns performance.now() at the drop, so a test can time what
   * follows on the page's own clock.
   */
  dropEventStreams(ms: number): number
  /** Takes the admin API and event stream offline for `ms`; returns the drop time. */
  takeServerOffline(ms: number): number
  /** Approves a pending device as the owner (its live events go out as usual); returns its id. */
  approvePendingDevice(): string
  /** The id of an approved device (the same on every load of the same mock size). */
  approvedDeviceId(): string
  /** Makes an operation (an operationId) answer 500 from now on, like ?mock-fail= but mid-test. */
  failOperation(operationId: string): void
  /**
   * Changes a device's group as PATCH /devices/{id} does, as the owner (audited, with its live
   * events), so a test can move a device out of a User's grants.
   */
  moveDevice(deviceId: string, groupId: string | null): void
  /** Ends an open session now, as the device closing it would (reason "disconnected" if an admin had asked).
   * With notify false no live event goes out, so a page still shows it open: the race a 409 answers.
   */
  endSession(sessionId: string, notify?: boolean): void
  /** Sets a mock user's SSO link and optionally removes their password for UI tests. */
  setUserSSO(username: string, hasPassword: boolean): void
  /** Changes one server health check, as if its latest background check completed. */
  setServerCheck(name: MockHealthCheck['name'], ok: boolean, detail?: string): void
  /** Reports whether a device has applied its current strategy version. */
  setDeviceVersionSeen(deviceId: string, applied: boolean): void
}

declare global {
  interface Window {
    __ferricadeMock?: MockControls
  }
}

export function createMockControls(env: Env): MockControls {
  const { db } = env
  return {
    setDeviceVersionSeen(deviceId, applied) {
      db.setDeviceVersionSeen(deviceId, applied)
    },
    expireSession() {
      env.session.userId = null
    },
    dropEventStreams(ms) {
      env.streams.holdUntil = db.now() + ms
      for (const close of [...env.streams.closers]) close()
      return performance.now()
    },
    takeServerOffline(ms) {
      env.offlineUntil = db.now() + ms
      for (const close of [...env.streams.closers]) close()
      return performance.now()
    },
    approvePendingDevice() {
      const device = db.devices().find((d) => d.state === 'pending')
      const owner = db.users.find((u) => u.role === 'owner')
      if (!device || !owner) throw new Error('mock: no pending device or no owner')
      const result = db.transition(device.id, 'approve', owner)
      if (!result.ok) throw new Error(`mock: approve failed: ${result.message}`)
      return device.id
    },
    moveDevice(deviceId, groupId) {
      const owner = db.users.find((u) => u.role === 'owner')
      if (!owner) throw new Error('mock: no owner')
      const result = db.patchDevice(deviceId, { group_id: groupId }, owner)
      if (!result.ok) throw new Error(`mock: move failed: ${result.message}`)
    },
    failOperation(operationId) {
      env.config = {
        ...env.config,
        failOperations: new Set([...env.config.failOperations, operationId]),
      }
    },
    endSession(sessionId, notify = true) {
      const row = db.sessionRows.find((s) => s.id === sessionId)
      if (!row || row.ended_at !== null) throw new Error('mock: no open session ' + sessionId)
      row.ended_at = new Date(db.now()).toISOString()
      row.end_reason = row.disconnect_requested_at === null ? 'closed' : 'disconnected'
      if (notify) db.emit({ type: 'session.ended', session_id: row.id, device_id: row.device_id })
    },
    setUserSSO(username, hasPassword) {
      const user = db.users.find((candidate) => candidate.username === username)
      if (!user) throw new Error(`mock: no user ${username}`)
      user.sso = true
      if (hasPassword) db.passwords.set(user.id, 'correct horse battery')
      else db.passwords.delete(user.id)
    },
    setServerCheck(name, ok, detail = '') {
      const now = new Date(db.now()).toISOString()
      const checks = env.health.checks.map((check) =>
        check.name === name
          ? {
              ...check,
              ok,
              detail: ok ? '' : detail,
              address: check.address || '203.0.113.10:21116',
              reason: ok ? null : ('refused' as const),
              since: check.ok === ok ? check.since : now,
            }
          : check,
      )
      env.health = {
        status: checks.every((check) => check.ok) ? 'ok' : 'degraded',
        checked_at: now,
        checks,
      }
    },
    approvedDeviceId() {
      const device = db.devices().find((d) => d.state === 'approved')
      if (!device) throw new Error('mock: no approved device')
      return device.id
    },
  }
}
