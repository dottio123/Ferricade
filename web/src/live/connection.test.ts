import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../lib/queryKeys'
import {
  connectLive,
  liveStatus,
  LIVE_TIMING,
  resumeLive,
  suspendLive,
  type EventSourceLike,
} from './connection'
import { LIVE_EVENT_TYPES } from './invalidation'

const DEVICE = '2b1f4a0e-6c41-4a39-9d7f-0a56a6f9a111'
const SESSION = '3c2e5b1f-7d52-4b4a-8e80-1b67b7a0b222'
/** What a device event invalidates (session lists and stats show device names). */
const DEVICE_KEYS = [
  ['devices'],
  ['summary'],
  ['fleet-map'],
  ['device', DEVICE],
  ['sessions'],
  ['session-stats'],
]

/** An EventSource the test drives: open, named messages, and errors. */
class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = FakeEventSource.CONNECTING
  closed = false
  private listeners = new Map<string, Set<(e: Event) => void>>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }
  static get last(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1)
    if (!last) throw new Error('no EventSource was created')
    return last
  }

  addEventListener(type: string, fn: (e: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  close(): void {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }
  private dispatch(type: string, e: Event): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e)
  }
  open(): void {
    this.readyState = FakeEventSource.OPEN
    this.dispatch('open', new Event('open'))
  }
  /** A message as the server writes it: `event: <type>`, `data: <json>`. */
  send(type: string, data: unknown): void {
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    this.dispatch(type, new MessageEvent(type, { data: text }))
  }
  /** A dropped connection: the browser retries by itself. */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING
    this.dispatch('error', new Event('error'))
  }
  /** A failed connection (a non-200 answer): the browser gives up. */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED
    this.dispatch('error', new Event('error'))
  }
}

let queryClient: QueryClient
let invalidated: QueryKey[]
let disconnect: () => void

function connect() {
  disconnect = connectLive(queryClient, {
    createEventSource: (url) => new FakeEventSource(url),
    probeServer: async () => 'up',
  })
  FakeEventSource.last.open()
}

/** Keys invalidated one by one (an invalidate-everything call is recorded as ['*']). */
function spyOnInvalidations() {
  invalidated = []
  vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async (filters) => {
    if (filters?.queryKey) invalidated.push(filters.queryKey)
    else if (filters?.predicate) invalidated.push(['live*'])
    else invalidated.push(['*'])
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.instances = []
  queryClient = new QueryClient()
  spyOnInvalidations()
})

afterEach(() => {
  disconnect?.()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('connectLive', () => {
  it('listens to the admin event stream, for every event type of the contract', () => {
    connect()
    expect(FakeEventSource.last.url).toBe('/admin/api/v1/events')
    expect([...LIVE_EVENT_TYPES].toSorted()).toEqual(
      [
        'audit.created',
        'device.deleted',
        'device.enrolled',
        'device.offline',
        'device.online',
        'device.updated',
        'group_rules.updated',
        'id_allow_list.updated',
        'preferences.updated',
        'resync',
        'session.ended',
        'session.started',
        'session.updated',
      ].toSorted(),
    )
  })

  it('invalidates the device lists, the summary, that device and the sessions after a device event', () => {
    connect()
    FakeEventSource.last.send('device.online', { type: 'device.online', device_id: DEVICE })
    expect(invalidated).toEqual([])
    vi.advanceTimersByTime(LIVE_TIMING.debounceMs)
    expect(invalidated).toEqual(DEVICE_KEYS)
  })

  it('invalidates sessions, the summary and session stats after a session event', () => {
    connect()
    FakeEventSource.last.send('session.ended', {
      type: 'session.ended',
      session_id: SESSION,
      device_id: DEVICE,
    })
    vi.advanceTimersByTime(LIVE_TIMING.debounceMs)
    expect(invalidated).toEqual([['sessions'], ['summary'], ['session-stats']])
  })

  it('invalidates the audit log and preferences after their events', () => {
    connect()
    FakeEventSource.last.send('audit.created', { type: 'audit.created', audit_id: SESSION })
    FakeEventSource.last.send('preferences.updated', {
      type: 'preferences.updated',
      user_id: SESSION,
    })
    vi.advanceTimersByTime(LIVE_TIMING.debounceMs)
    expect(invalidated).toEqual([['audit'], ['preferences']])
  })

  it('invalidates every ID allow list query after a list change', () => {
    connect()
    FakeEventSource.last.send('id_allow_list.updated', { type: 'id_allow_list.updated' })
    vi.advanceTimersByTime(LIVE_TIMING.debounceMs)
    expect(invalidated).toEqual([['settings', 'id-allow-list'], ['groups'], ['device']])
  })

  it('coalesces a burst (a server restart: one device.online per device) into one invalidation per key', () => {
    connect()
    for (let i = 0; i < 400; i++) {
      FakeEventSource.last.send('device.online', { type: 'device.online', device_id: DEVICE })
    }
    vi.advanceTimersByTime(LIVE_TIMING.debounceMs)
    expect(invalidated).toEqual(DEVICE_KEYS)
    // A later event invalidates again.
    FakeEventSource.last.send('device.offline', { type: 'device.offline', device_id: DEVICE })
    vi.advanceTimersByTime(LIVE_TIMING.debounceMs)
    expect(invalidated).toHaveLength(2 * DEVICE_KEYS.length)
  })

  it('does not starve: a steady stream of events still invalidates every debounce period', () => {
    connect()
    for (let t = 0; t < 1000; t += 50) {
      FakeEventSource.last.send('device.updated', { type: 'device.updated', device_id: DEVICE })
      vi.advanceTimersByTime(50)
    }
    expect(invalidated.filter((k) => k[0] === 'summary').length).toBeGreaterThanOrEqual(3)
  })

  it('ignores messages it cannot read', () => {
    connect()
    FakeEventSource.last.send('device.online', 'not json')
    FakeEventSource.last.send('device.online', { type: 'session.ended' })
    FakeEventSource.last.send('device.online', null)
    vi.advanceTimersByTime(LIVE_TIMING.debounceMs)
    expect(invalidated).toEqual([])
  })

  it('refetches everything once after resync, when the stream is back', () => {
    connect()
    const first = FakeEventSource.last
    first.send('resync', { type: 'resync' })
    // Not yet: a refetch now would miss what changes before the stream reopens.
    expect(invalidated).toEqual([])
    // The server ends the stream; the browser reconnects by itself.
    first.drop()
    first.open()
    expect(invalidated).toEqual([['*']])
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})

describe('the live status', () => {
  it.each([
    ['up', 'reconnecting'],
    ['down', 'offline'],
  ] as const)('probes after 10 s and maps %s to %s', async (answer, expected) => {
    const probeServer = vi.fn(async () => answer)
    disconnect = connectLive(queryClient, {
      createEventSource: (url) => new FakeEventSource(url),
      probeServer,
    })
    FakeEventSource.last.open()
    FakeEventSource.last.drop()
    await vi.advanceTimersByTimeAsync(LIVE_TIMING.reconnectingAfterMs - 1)
    expect(probeServer).not.toHaveBeenCalled()
    expect(liveStatus.get()).toBe('live')
    await vi.advanceTimersByTimeAsync(1)
    expect(probeServer).toHaveBeenCalledTimes(1)
    expect(liveStatus.get()).toBe(expected)
  })

  it('moves from offline to reconnecting on a later fallback tick', async () => {
    const probeServer = vi.fn().mockResolvedValueOnce('down').mockResolvedValue('up')
    disconnect = connectLive(queryClient, {
      createEventSource: (url) => new FakeEventSource(url),
      probeServer,
    })
    FakeEventSource.last.open()
    FakeEventSource.last.drop()
    await vi.advanceTimersByTimeAsync(LIVE_TIMING.reconnectingAfterMs)
    expect(liveStatus.get()).toBe('offline')
    await vi.advanceTimersByTimeAsync(
      LIVE_TIMING.fallbackRefetchMs - LIVE_TIMING.reconnectingAfterMs,
    )
    expect(liveStatus.get()).toBe('reconnecting')
  })

  it('ignores a probe that resolves after the stream opens', async () => {
    let resolve!: (answer: 'down') => void
    const probeServer = vi.fn(() => new Promise<'down'>((r) => (resolve = r)))
    disconnect = connectLive(queryClient, {
      createEventSource: (url) => new FakeEventSource(url),
      probeServer,
    })
    FakeEventSource.last.open()
    FakeEventSource.last.drop()
    await vi.advanceTimersByTimeAsync(LIVE_TIMING.reconnectingAfterMs)
    FakeEventSource.last.open()
    resolve('down')
    await vi.advanceTimersByTimeAsync(0)
    expect(liveStatus.get()).toBe('live')
  })

  it('allows only one probe in flight', async () => {
    let resolve!: (answer: 'up') => void
    const probeServer = vi.fn(() => new Promise<'up'>((r) => (resolve = r)))
    disconnect = connectLive(queryClient, {
      createEventSource: (url) => new FakeEventSource(url),
      probeServer,
    })
    FakeEventSource.last.open()
    FakeEventSource.last.drop()
    await vi.advanceTimersByTimeAsync(LIVE_TIMING.fallbackRefetchMs * 3)
    expect(probeServer).toHaveBeenCalledTimes(1)
    resolve('up')
    await vi.advanceTimersByTimeAsync(0)
    expect(liveStatus.get()).toBe('reconnecting')
  })

  it.each([
    ['network error', null, 'offline'],
    ['bad gateway', 502, 'offline'],
    ['unavailable', 503, 'offline'],
    ['gateway timeout', 504, 'offline'],
    ['ok', 200, 'reconnecting'],
    ['unauthorized', 401, 'reconnecting'],
    ['internal error', 500, 'reconnecting'],
  ] as const)('the default probe maps %s to %s', async (_case, code, expected) => {
    const fetchMock = vi.fn(() =>
      code === null
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(
            new Response(JSON.stringify({ error: { code: 'internal', message: 'test' } }), {
              status: code,
              headers: { 'Content-Type': 'application/json' },
            }),
          ),
    )
    vi.stubGlobal('fetch', fetchMock)
    disconnect = connectLive(queryClient, { createEventSource: (url) => new FakeEventSource(url) })
    FakeEventSource.last.open()
    FakeEventSource.last.drop()
    await vi.advanceTimersByTimeAsync(LIVE_TIMING.reconnectingAfterMs)
    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET' }))
    expect(liveStatus.get()).toBe(expected)
  })
  it('stays "live" for the first 10 s without a connection, then shows "reconnecting"', async () => {
    connect()
    expect(liveStatus.get()).toBe('live')
    FakeEventSource.last.drop()
    await vi.advanceTimersByTimeAsync(LIVE_TIMING.reconnectingAfterMs - 1)
    expect(liveStatus.get()).toBe('live')
    await vi.advanceTimersByTimeAsync(1)
    expect(liveStatus.get()).toBe('reconnecting')
    FakeEventSource.last.open()
    expect(liveStatus.get()).toBe('live')
  })

  it('counts a connection that never opens as down', async () => {
    disconnect = connectLive(queryClient, {
      createEventSource: (url) => new FakeEventSource(url),
      probeServer: async () => 'up',
    })
    await vi.advanceTimersByTimeAsync(LIVE_TIMING.reconnectingAfterMs)
    expect(liveStatus.get()).toBe('reconnecting')
  })

  it('does not restart the 10 s on each failed retry', async () => {
    connect()
    FakeEventSource.last.drop()
    await vi.advanceTimersByTimeAsync(6000)
    FakeEventSource.last.drop()
    await vi.advanceTimersByTimeAsync(4000)
    expect(liveStatus.get()).toBe('reconnecting')
  })

  it('tells subscribers when it changes', async () => {
    connect()
    const seen: string[] = []
    const unsubscribe = liveStatus.subscribe(() => seen.push(liveStatus.get()))
    FakeEventSource.last.drop()
    await vi.advanceTimersByTimeAsync(LIVE_TIMING.reconnectingAfterMs)
    FakeEventSource.last.open()
    unsubscribe()
    expect(seen).toEqual(['reconnecting', 'live'])
  })

  it('records the time only when the status changes', async () => {
    vi.setSystemTime(new Date('2026-10-14T10:00:00Z'))
    connect()
    const liveSince = liveStatus.getSince()
    FakeEventSource.last.drop()
    await vi.advanceTimersByTimeAsync(LIVE_TIMING.reconnectingAfterMs)
    expect(liveStatus.getSince()).toBe(Date.parse('2026-10-14T10:00:10Z'))
    FakeEventSource.last.drop()
    expect(liveStatus.getSince()).toBe(Date.parse('2026-10-14T10:00:10Z'))
    expect(liveStatus.getSince()).not.toBe(liveSince)
    FakeEventSource.last.open()
    expect(liveStatus.getSince()).toBe(Date.parse('2026-10-14T10:00:10Z'))
  })

  it('is "live" again after disconnecting (the shell is gone)', async () => {
    connect()
    FakeEventSource.last.drop()
    await vi.advanceTimersByTimeAsync(LIVE_TIMING.reconnectingAfterMs)
    disconnect()
    expect(liveStatus.get()).toBe('live')
    expect(FakeEventSource.last.closed).toBe(true)
  })
})

describe('when the stream first opens', () => {
  // A change between a page's first fetch and the stream's open is announced
  // before the page listens: what was fetched before the open is refetched.
  it('refetches the live queries already fetched', async () => {
    queryClient.setQueryData(queryKeys.devices.all(), [])
    connect()
    await vi.waitFor(() => expect(invalidated).toEqual([['live*']]))
  })

  // TanStack Query joins an invalidation onto a first fetch still in flight
  // (no data yet) instead of starting a new one, and that fetch may have been
  // answered before the change (the live CI job: the queue's first page came
  // back empty, the device enrolled, the stream opened, and the list never
  // refetched).
  it('starts again a first fetch still in flight when the stream opens', async () => {
    vi.mocked(queryClient.invalidateQueries).mockRestore()
    const answers: ((v: string) => void)[] = []
    const observer = new QueryObserver(queryClient, {
      queryKey: queryKeys.devices.list({ state: 'pending' }),
      queryFn: () => new Promise<string>((resolve) => answers.push(resolve)),
      staleTime: Infinity,
      retry: false,
    })
    const stop = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(answers).toHaveLength(1)

    connect()
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    // The answer from before the open does not win over the one after it.
    answers[0]!('before the open')
    answers[1]!('after the open')
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.getCurrentResult().data).toBe('after the open')
    stop()
  })

  it('refetches nothing when nothing was fetched yet', () => {
    connect()
    expect(invalidated).toEqual([])
  })

  it('leaves queries outside the stream alone', () => {
    queryClient.setQueryData(queryKeys.tags.all(), [])
    connect()
    expect(invalidated).toEqual([])
  })
})

describe('while disconnected', () => {
  it('refetches the live queries every 15 s, and stops once the stream is back', () => {
    connect()
    FakeEventSource.last.drop()
    vi.advanceTimersByTime(LIVE_TIMING.fallbackRefetchMs - 1)
    expect(invalidated).toEqual([])
    vi.advanceTimersByTime(1)
    expect(invalidated).toEqual([['live*']])
    vi.advanceTimersByTime(LIVE_TIMING.fallbackRefetchMs)
    expect(invalidated).toEqual([['live*'], ['live*']])
    FakeEventSource.last.open()
    // Events were missed while the stream was down: everything is refetched once.
    expect(invalidated).toEqual([['live*'], ['live*'], ['*']])
    vi.advanceTimersByTime(LIVE_TIMING.fallbackRefetchMs * 3)
    expect(invalidated).toHaveLength(3)
  })

  it('refetches only live queries in the fallback', async () => {
    vi.mocked(queryClient.invalidateQueries).mockRestore()
    const fetched: string[] = []
    const observe = (key: QueryKey) => {
      const observer = new QueryObserver(queryClient, {
        queryKey: key,
        queryFn: () => {
          fetched.push(String(key[0]))
          return 1
        },
        staleTime: Infinity,
      })
      return observer.subscribe(() => {})
    }
    const stops = [
      observe(queryKeys.summary()),
      observe(queryKeys.devices.list({ state: 'pending' })),
      observe(queryKeys.groups()),
    ]
    await vi.advanceTimersByTimeAsync(0)
    fetched.length = 0
    connect()
    // The first open refetches what was fetched before it (the live ones only).
    await vi.advanceTimersByTimeAsync(0)
    expect(fetched.toSorted()).toEqual(['devices', 'groups', 'summary'])
    fetched.length = 0
    FakeEventSource.last.drop()
    await vi.advanceTimersByTimeAsync(LIVE_TIMING.fallbackRefetchMs)
    expect(fetched.toSorted()).toEqual(['devices', 'groups', 'summary'])
    for (const stop of stops) stop()
  })

  it('opens a new stream when the browser gave up, and checks the session', () => {
    connect()
    const first = FakeEventSource.last
    first.fail()
    expect(invalidated).toContainEqual(queryKeys.me())
    vi.advanceTimersByTime(LIVE_TIMING.retryMs)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(first.closed).toBe(true)
    // It backs off while the stream keeps failing.
    FakeEventSource.last.fail()
    vi.advanceTimersByTime(LIVE_TIMING.retryMs)
    expect(FakeEventSource.instances).toHaveLength(2)
    vi.advanceTimersByTime(LIVE_TIMING.retryMs)
    expect(FakeEventSource.instances).toHaveLength(3)
    FakeEventSource.last.open()
    expect(liveStatus.get()).toBe('live')
  })

  it('stops everything on disconnect', () => {
    connect()
    FakeEventSource.last.fail()
    disconnect()
    vi.advanceTimersByTime(LIVE_TIMING.fallbackRefetchMs * 4)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(invalidated).toEqual([queryKeys.me()])
  })
})

describe('while signing out', () => {
  // The session ends on the server while the page is still on screen: a
  // refetch then would answer 401 (the queued one, the fallback, a retry).
  it('does not refetch a session queued by the stream opening just before suspension', async () => {
    queryClient.setQueryData(queryKeys.sessions.list({ active: 'true' }), { items: [] })
    disconnect = connectLive(queryClient, {
      createEventSource: (url) => new FakeEventSource(url),
    })
    FakeEventSource.last.open()
    suspendLive()
    await vi.advanceTimersByTimeAsync(0)
    expect(invalidated).toEqual([])
  })

  it('refetches nothing once suspended, not even what was queued', () => {
    connect()
    FakeEventSource.last.send('device.online', { type: 'device.online', device_id: DEVICE })
    suspendLive()
    expect(FakeEventSource.last.closed).toBe(true)
    vi.advanceTimersByTime(LIVE_TIMING.debounceMs + LIVE_TIMING.fallbackRefetchMs * 2)
    expect(invalidated).toEqual([])
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('opens the stream again on resume and then refetches everything once', () => {
    connect()
    suspendLive()
    resumeLive()
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(invalidated).toEqual([])
    FakeEventSource.last.open()
    expect(invalidated).toEqual([['*']])
  })

  it('does nothing without a connection', () => {
    expect(() => {
      suspendLive()
      resumeLive()
    }).not.toThrow()
  })
})
