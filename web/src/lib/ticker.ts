import * as React from 'react'

type Listener = { notify: () => void; intervalMs: number; lastNotified: number }
const listeners = new Set<Listener>()
let intervalId: ReturnType<typeof setInterval> | null = null
let currentClockTime = typeof window !== 'undefined' ? Date.now() : 0

function tick(): void {
  currentClockTime = Date.now()
  listeners.forEach((listener) => {
    if (currentClockTime - listener.lastNotified >= listener.intervalMs) {
      listener.lastNotified = currentClockTime
      listener.notify()
    }
  })
}

export function subscribeTicker(notify: () => void, intervalMs = 1000): () => void {
  const listener = { notify, intervalMs, lastNotified: Date.now() }
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined') {
    currentClockTime = Date.now()
    intervalId = setInterval(tick, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
  }
}

export function getTickerListenerCount(): number {
  return listeners.size
}

export function isTickerRunning(): boolean {
  return intervalId !== null
}

function getClientNow(): number {
  return currentClockTime
}

function getServerNow(): number {
  return 0
}

/**
 * Shared 1-second clock hook using useSyncExternalStore.
 * All components share a single setInterval which only runs when there are active subscribers.
 */
export function useSharedTicker(intervalMs = 1000): number {
  const subscribe = React.useCallback(
    (notify: () => void) => subscribeTicker(notify, intervalMs),
    [intervalMs],
  )
  return React.useSyncExternalStore(subscribe, getClientNow, getServerNow)
}

/**
 * Formats duration in seconds into human-readable shorthand:
 * - < 60s: "12s"
 * - >= 60s and < 3600s: "4m 12s" (or "4m" if 0s)
 * - >= 3600s: "2h 15m" (or "2h" if 0m)
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60

  if (hrs > 0) {
    if (mins > 0) return `${hrs}h ${mins}m`
    return `${hrs}h`
  }
  if (mins > 0) {
    if (secs > 0) return `${mins}m ${secs}s`
    return `${mins}m`
  }
  return `${secs}s`
}

/**
 * Converts chosen start and end date strings (YYYY-MM-DD) into ISO strings for `since` and `until`.
 * - `since` is the start of the start day (00:00:00.000 local time).
 * - `until` is the start of the following day (00:00:00.000 local time) because `until` in the API is exclusive.
 */
export function dateRangeToIso(
  startDateStr: string,
  endDateStr: string,
): { since: string; until: string } {
  const [sYear, sMonth, sDay] = startDateStr.split('-').map(Number)
  const [eYear, eMonth, eDay] = endDateStr.split('-').map(Number)

  if (!sYear || !sMonth || !sDay || !eYear || !eMonth || !eDay) {
    throw new Error(`Invalid date format for range: ${startDateStr} - ${endDateStr}`)
  }

  // Month is 0-indexed in JS Date
  const sinceDate = new Date(sYear, sMonth - 1, sDay, 0, 0, 0, 0)
  // End date is inclusive to the user, so exclusive `until` is the start of the day after
  const untilDate = new Date(eYear, eMonth - 1, eDay + 1, 0, 0, 0, 0)

  return {
    since: sinceDate.toISOString(),
    until: untilDate.toISOString(),
  }
}
