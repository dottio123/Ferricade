import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { connectLive, liveStatus, type LiveStatus } from './connection'

/**
 * Keeps the admin event stream open while mounted, invalidating queries as
 * events arrive (src/live/invalidation.ts). Mount it once, in the app shell.
 */
export function useLiveEvents(): void {
  const queryClient = useQueryClient()
  useEffect(() => connectLive(queryClient), [queryClient])
}

/** "live" with the stream, "reconnecting" when the server answers, or "offline" when it does not. */
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(liveStatus.subscribe, liveStatus.get)
}

/** Epoch milliseconds when the current connection status began. */
export function useLiveStatusSince(): number {
  return useSyncExternalStore(liveStatus.subscribe, liveStatus.getSince)
}
