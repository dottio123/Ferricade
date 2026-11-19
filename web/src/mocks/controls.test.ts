import { afterEach, describe, expect, it } from 'vitest'
import { readMockConfig } from './config'
import { createMockControls } from './controls'
import { createMockDB } from './db'
import { createMockApi } from './handlers'
import { setupServer } from 'msw/node'

const V1 = '/admin/api/v1'

function start(clock?: () => number) {
  const db = createMockDB('small', { clock })
  const { handlers, env } = createMockApi(db, readMockConfig(''))
  const server = setupServer(...handlers)
  server.listen({ onUnhandledRequest: 'error' })
  return { db, env, server, controls: createMockControls(env) }
}

let stop: () => void = () => {}
afterEach(() => stop())

async function pending(): Promise<number> {
  const res = await fetch(new Request(`${V1}/stats/summary`))
  const body = (await res.json()) as { devices: { pending: number } }
  return body.devices.pending
}

describe('?mock-session=', () => {
  it.each([
    ['signed-out', 401, undefined],
    ['mfa', 200, { mfa_passed: false, totp_enrolled: true }],
    ['enroll', 200, { mfa_passed: false, totp_enrolled: false }],
    ['', 200, { mfa_passed: true, totp_enrolled: true }],
  ])('%s starts the session in that state', async (value, status, state) => {
    const db = createMockDB('small')
    const { handlers } = createMockApi(db, readMockConfig(`?mock-session=${value}`))
    const server = setupServer(...handlers)
    server.listen({ onUnhandledRequest: 'error' })
    stop = () => server.close()
    const res = await fetch(new Request(`${V1}/auth/me`))
    expect(res.status).toBe(status)
    if (state) expect(await res.json()).toMatchObject(state)
  })
})

describe('the mock controls (for the Playwright flows)', () => {
  it('sets a device policy version as applied or pending and emits device.updated', () => {
    const { db, server, controls } = start()
    stop = () => server.close()
    const owner = db.users.find((u) => u.role === 'owner')!
    const device = db.deviceRows.find((d) => d.state === 'approved')!
    db.setPolicyPush(true, owner)
    const seen: { type: string; device_id?: string }[] = []
    const off = db.subscribe((e) => seen.push(e))
    controls.setDeviceVersionSeen(device.id, true)
    expect(db.devicePolicyStatus(device.id)).toMatchObject({
      ok: true,
      value: { status: 'applied' },
    })
    expect(seen).toContainEqual({ type: 'device.updated', device_id: device.id })
    seen.length = 0
    controls.setDeviceVersionSeen(device.id, false)
    expect(db.devicePolicyStatus(device.id)).toMatchObject({
      ok: true,
      value: { status: 'pending' },
    })
    expect(seen).toContainEqual({ type: 'device.updated', device_id: device.id })
    off()
  })
  it('rejects requests with no mock handler without reaching the network', async () => {
    const { server } = start()
    stop = () => server.close()
    // Force MSW's passthrough path to exercise the suite-wide network guard.
    server.close()
    server.listen({ onUnhandledRequest: 'bypass' })
    await expect(fetch(new Request(`${V1}/not-a-mock-route`))).rejects.toThrow(
      'Unmocked network request',
    )
  })

  it('expireSession makes the next call answer 401', async () => {
    const { server, controls } = start()
    stop = () => server.close()
    expect((await fetch(new Request(`${V1}/auth/me`))).status).toBe(200)
    controls.expireSession()
    expect((await fetch(new Request(`${V1}/auth/me`))).status).toBe(401)
  })

  it('approvePendingDevice approves one and returns its id', async () => {
    const { server, controls } = start()
    stop = () => server.close()
    const before = await pending()
    const id = controls.approvePendingDevice()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await pending()).toBe(before - 1)
  })

  it('endSession ends an open session', async () => {
    const { server, controls } = start()
    stop = () => server.close()
    const open = async () =>
      (
        (await (await fetch(new Request(`${V1}/sessions?active=true`))).json()) as {
          items: { id: string }[]
        }
      ).items.map((s) => s.id)
    const before = await open()
    controls.endSession(before[0]!)
    expect(await open()).toEqual(before.slice(1))
  })

  it('failOperation makes that operation answer 500 from now on', async () => {
    const { server, controls } = start()
    stop = () => server.close()
    expect((await fetch(new Request(`${V1}/stats/summary`))).status).toBe(200)
    controls.failOperation('statsSummary')
    expect((await fetch(new Request(`${V1}/stats/summary`))).status).toBe(500)
    expect((await fetch(new Request(`${V1}/auth/me`))).status).toBe(200)
  })

  it('setServerCheck updates the latest health round and only resets since on a status change', async () => {
    const { server, controls } = start()
    stop = () => server.close()
    const before = (await (await fetch(new Request(`${V1}/server/health`))).json()) as {
      status: string
      checked_at: string
      checks: { name: string; ok: boolean; detail: string; since: string }[]
    }
    const relay = before.checks.find((check) => check.name === 'relay')!
    expect(before.status).toBe('ok')
    controls.setServerCheck('relay', false, 'relay unavailable')
    const failed = (await (await fetch(new Request(`${V1}/server/health`))).json()) as typeof before
    const failedRelay = failed.checks.find((check) => check.name === 'relay')!
    expect(failed.status).toBe('degraded')
    expect(failedRelay).toMatchObject({ ok: false, detail: 'relay unavailable' })
    expect(Date.parse(failedRelay.since)).not.toBeNaN()
    expect(failed.checked_at).toBe(failedRelay.since)
    controls.setServerCheck('relay', false, 'still unavailable')
    const unchanged = (await (
      await fetch(new Request(`${V1}/server/health`))
    ).json()) as typeof before
    expect(unchanged.checks.find((check) => check.name === 'relay')?.since).toBe(failedRelay.since)
    expect(unchanged.checked_at).not.toBe(failed.checked_at)
    expect(unchanged.checks.find((check) => check.name === 'relay')?.since).toBe(failedRelay.since)
    controls.setServerCheck('relay', true)
    const recovered = (await (
      await fetch(new Request(`${V1}/server/health`))
    ).json()) as typeof before
    expect(recovered.status).toBe('ok')
    expect(recovered.checks.find((check) => check.name === 'relay')?.since).toBe(
      recovered.checked_at,
    )
    expect(relay.since).not.toBe('')
  })

  it('approvedDeviceId names an approved device', () => {
    const { db, server, controls } = start()
    stop = () => server.close()
    expect(db.device(controls.approvedDeviceId())?.state).toBe('approved')
  })

  it('dropEventStreams ends the open streams and holds new ones back for a while', async () => {
    const { server, controls } = start()
    stop = () => server.close()
    const read = async (ms: number) => {
      const abort = new AbortController()
      const res = fetch(
        new Request(`${V1}/events`, {
          headers: { Accept: 'text/event-stream' },
          signal: abort.signal,
        }),
      )
      const timeout = new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))
      const outcome = await Promise.race([res, timeout])
      abort.abort()
      return outcome
    }

    const res = await fetch(
      new Request(`${V1}/events`, { headers: { Accept: 'text/event-stream' } }),
    )
    const reader = res.body!.getReader()
    await reader.read() // retry: 3000
    controls.dropEventStreams(300)
    expect((await reader.read()).done).toBe(true)
    expect(await read(100)).toBe('pending')
    await new Promise((r) => setTimeout(r, 250))
    const later = await read(500)
    expect(later).not.toBe('pending')
  })

  it('dropEventStreams returns when it dropped them, on the clock of performance.now()', () => {
    const { server, controls } = start()
    stop = () => server.close()
    const before = performance.now()
    const at = controls.dropEventStreams(0)
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(performance.now())
  })

  it('takeServerOffline closes streams and fails every API request until the deadline', async () => {
    let now = Date.now()
    const { server, controls } = start(() => now)
    stop = () => server.close()
    const response = await fetch(
      new Request(`${V1}/events`, { headers: { Accept: 'text/event-stream' } }),
    )
    const reader = response.body!.getReader()
    await reader.read()
    const before = performance.now()
    const at = controls.takeServerOffline(50)
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(performance.now())
    expect((await reader.read()).done).toBe(true)
    await expect(fetch(new Request(`${V1}/auth/me`))).rejects.toThrow()
    await expect(fetch(new Request(`${V1}/stats/summary`))).rejects.toThrow()
    await expect(fetch(new Request(`${V1}/events`))).rejects.toThrow()
    now += 50
    expect((await fetch(new Request(`${V1}/auth/me`))).status).toBe(200)
  })
})
