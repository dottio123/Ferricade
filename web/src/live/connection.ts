// The admin event stream (GET /admin/api/v1/events), kept open while the shell
// is mounted. Each event invalidates the queries LIVE_INVALIDATIONS names, so
// pages refetch what changed. This EventSource is the one request the app
// makes outside src/api/client.ts (EventSource is not fetch): it is same-origin
// and sends the session cookie.
import { hashKey, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { api } from '../api/client'
import { ApiError } from '../api/errors'
import type { paths } from '../api/schema'
import { queryKeys } from '../lib/queryKeys'
import {
  isLiveQueryKey,
  LIVE_EVENT_TYPES,
  LIVE_INVALIDATIONS,
  parseLiveEvent,
  type LiveEventType,
} from './invalidation'

export const EVENTS_URL = '/admin/api/v1/events' satisfies keyof paths

export const LIVE_TIMING = {
  /** Events for the same key within this window cause one invalidation (a server restart sends one device.online per device). */
  debounceMs: 250,
  /** The UI probes the server after this long without a stream. */
  reconnectingAfterMs: 10_000,
  /** While the stream is down, live queries are refetched this often instead. */
  fallbackRefetchMs: 15_000,
  /** The first wait before opening a new stream when the browser gave up; it doubles up to maxRetryMs. */
  retryMs: 3_000,
  maxRetryMs: 30_000,
}

export type LiveStatus = 'live' | 'reconnecting' | 'offline'

/** The part of EventSource this module uses. */
export interface EventSourceLike {
  readonly readyState: number
  addEventListener(type: string, listener: (event: Event) => void): void
  close(): void
}

const CLOSED = 2 // EventSource.CLOSED: the browser will not retry

// ---- status ------------------------------------------------------------------

let status: LiveStatus = 'live'
let statusSince = Date.now()
const listeners = new Set<() => void>()

function setStatus(next: LiveStatus): void {
  if (next === status) return
  status = next
  statusSince = Date.now()
  for (const listener of [...listeners]) listener()
}

/** This browser's connection to the admin server. */
export const liveStatus = {
  get: (): LiveStatus => status,
  getSince: (): number => statusSince,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

// ---- connection --------------------------------------------------------------

// The open connection, for sign-out to suspend: the session ends on the server
// while the page is still on screen, and a refetch then would answer 401.
let active: { suspend(): void; resume(): void } | null = null

/** Closes the stream and drops queued refetches until resumeLive (sign-out). */
export function suspendLive(): void {
  active?.suspend()
}

/** Opens the stream again after suspendLive, then refetches everything once. */
export function resumeLive(): void {
  active?.resume()
}

export interface LiveOptions {
  createEventSource?: (url: string) => EventSourceLike
  probeServer?: () => Promise<'up' | 'down'>
}

async function defaultProbeServer(): Promise<'up' | 'down'> {
  try {
    await api.GET('/admin/api/v1/auth/me')
    return 'up'
  } catch (error) {
    if (error instanceof ApiError) {
      return [502, 503, 504].includes(error.status) ? 'down' : 'up'
    }
    return 'down'
  }
}

/** Opens the stream and keeps it open. Returns the function that closes it for good. */
export function connectLive(queryClient: QueryClient, options: LiveOptions = {}): () => void {
  const create = options.createEventSource ?? ((url: string) => new EventSource(url))
  const probeServer = options.probeServer ?? defaultProbeServer

  let source: EventSourceLike | null = null
  let stopped = false
  let suspended = false
  let everOpened = false
  /** Events may have been missed since the stream was last open. */
  let missed = false
  let retryDelay = LIVE_TIMING.retryMs
  let reconnectingTimer: ReturnType<typeof setTimeout> | undefined
  let fallbackTimer: ReturnType<typeof setInterval> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let streamOpen = false
  let pastThreshold = false
  let downGeneration = 0
  let probeInFlight = false
  const debounced = new Map<string, ReturnType<typeof setTimeout>>()

  const invalidateAll = () => void queryClient.invalidateQueries()

  function invalidateSoon(key: QueryKey): void {
    const hash = hashKey(key)
    if (debounced.has(hash)) return
    debounced.set(
      hash,
      setTimeout(() => {
        debounced.delete(hash)
        void queryClient.invalidateQueries({ queryKey: key })
      }, LIVE_TIMING.debounceMs),
    )
  }

  async function probe(): Promise<void> {
    if (!pastThreshold || probeInFlight || streamOpen || suspended || stopped) return
    probeInFlight = true
    const generation = downGeneration
    try {
      const result = await probeServer()
      if (generation === downGeneration && !streamOpen && !suspended && !stopped) {
        setStatus(result === 'down' ? 'offline' : 'reconnecting')
      }
    } catch {
      if (generation === downGeneration && !streamOpen && !suspended && !stopped) {
        setStatus('offline')
      }
    } finally {
      probeInFlight = false
    }
  }

  // Down: probe after 10 s, and refetch live queries on a timer.
  // Neither restarts while already running, so failed retries do not reset them.
  function startDownTimers(): void {
    reconnectingTimer ??= setTimeout(() => {
      pastThreshold = true
      void probe()
    }, LIVE_TIMING.reconnectingAfterMs)
    fallbackTimer ??= setInterval(() => {
      void queryClient.invalidateQueries({ predicate: (q) => isLiveQueryKey(q.queryKey) })
      void probe()
    }, LIVE_TIMING.fallbackRefetchMs)
  }

  function stopDownTimers(): void {
    downGeneration++
    pastThreshold = false
    clearTimeout(reconnectingTimer)
    clearInterval(fallbackTimer)
    reconnectingTimer = undefined
    fallbackTimer = undefined
  }

  // A change between a page's first fetch and the stream's first open was
  // announced before anyone listened: refetch what was fetched (or was being
  // fetched) by then. Nothing when no live query has started yet. An
  // invalidation joins a first fetch still in flight (no data yet) instead of
  // starting a new one, and that fetch may have been answered before the
  // change, so it is cancelled first.
  function refetchFetchedBeforeOpen(): void {
    // Chosen before the cancel, which leaves a first fetch neither fetched nor fetching.
    const stale = new Set(
      queryClient.getQueryCache().findAll({
        predicate: (q) =>
          isLiveQueryKey(q.queryKey) &&
          (q.state.dataUpdatedAt > 0 || q.state.fetchStatus === 'fetching'),
      }),
    )
    if (stale.size === 0) return
    const firstInFlight = (q: Query) =>
      stale.has(q) && q.state.fetchStatus === 'fetching' && q.state.data === undefined
    void queryClient.cancelQueries({ predicate: firstInFlight }).then(() => {
      // Sign-out can suspend the stream while cancellation is still pending.
      if (stopped || suspended) return
      return queryClient.invalidateQueries({ predicate: (q) => stale.has(q) })
    })
  }

  function onMessage(type: LiveEventType, message: Event): void {
    const event = parseLiveEvent(type, (message as MessageEvent).data)
    if (!event) return
    const keys = LIVE_INVALIDATIONS[type](event)
    // resync: the server may have dropped events and ends the stream next.
    // Everything is refetched once the new stream is open, not now, so that
    // changes made while it reconnects are not missed either.
    if (keys === 'all') missed = true
    else for (const key of keys) invalidateSoon(key)
  }

  function open(): void {
    if (stopped || suspended) return
    const es = create(EVENTS_URL)
    source = es
    es.addEventListener('open', () => {
      streamOpen = true
      retryDelay = LIVE_TIMING.retryMs
      stopDownTimers()
      setStatus('live')
      if (missed) {
        missed = false
        invalidateAll()
      } else if (!everOpened) {
        refetchFetchedBeforeOpen()
      }
      everOpened = true
    })
    es.addEventListener('error', () => {
      streamOpen = false
      missed = true
      startDownTimers()
      // A dropped stream is retried by the browser. A refused one (a non-200
      // answer, such as a 401 after the session ended, or a proxy's 502 during
      // a restart) is not: open a new one later, and ask the server whether the
      // session is still there (a 401 sends the user to sign-in).
      if (es.readyState === CLOSED && source === es) {
        es.close()
        source = null
        void queryClient.invalidateQueries({ queryKey: queryKeys.me() })
        retryTimer = setTimeout(open, retryDelay)
        retryDelay = Math.min(retryDelay * 2, LIVE_TIMING.maxRetryMs)
      }
    })
    for (const type of LIVE_EVENT_TYPES) {
      es.addEventListener(type, (message) => onMessage(type, message))
    }
  }

  open()
  // Until the first open, the stream counts as down.
  startDownTimers()

  function quiet(): void {
    streamOpen = false
    source?.close()
    source = null
    stopDownTimers()
    clearTimeout(retryTimer)
    for (const timer of debounced.values()) clearTimeout(timer)
    debounced.clear()
  }

  const handle = {
    suspend(): void {
      suspended = true
      quiet()
    },
    resume(): void {
      if (stopped || !suspended) return
      suspended = false
      missed = true
      open()
      startDownTimers()
    },
  }
  active = handle

  return () => {
    stopped = true
    quiet()
    setStatus('live')
    if (active === handle) active = null
  }
}
