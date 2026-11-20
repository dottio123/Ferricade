import { useQueries, useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { api, unwrap } from '@/api/client'
import { useRole } from '@/auth/role'
import { deviceName } from '@/lib/device'
import { queryKeys } from '@/lib/queryKeys'
import { auditDeviceTarget, type AuditEvent } from './describe'

/**
 * The names of the devices audit entries are about, by device ID. Entries
 * carry IDs only; each device is fetched once (cached by queryKeys.device).
 */
export function useAuditDeviceNames(events: readonly AuditEvent[]): Map<string, string> {
  // A User's entries can be about devices no longer granted to them, which answer 404: look
  // the names up in the devices they can see instead (the first 200; others show their ID).
  const isUser = useRole() === 'user'
  const visible = useQuery({
    queryKey: queryKeys.devices.list({ limit: 200 }),
    queryFn: ({ signal }) =>
      unwrap(api.GET('/admin/api/v1/devices', { params: { query: { limit: 200 } }, signal })),
    enabled: isUser,
  })

  const ids = React.useMemo(() => {
    const set = new Set<string>()
    for (const e of events) {
      const id = auditDeviceTarget(e)
      if (id) set.add(id)
    }
    return [...set]
  }, [events])

  const queries = useQueries({
    queries: (isUser ? [] : ids).map((id) => ({
      queryKey: queryKeys.device(id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        unwrap(api.GET('/admin/api/v1/devices/{id}', { params: { path: { id } }, signal })),
      staleTime: 60_000,
    })),
  })

  return React.useMemo(() => {
    const map = new Map<string, string>()
    if (isUser) {
      for (const device of visible.data?.items ?? []) {
        if (ids.includes(device.id)) map.set(device.id, deviceName(device))
      }
      return map
    }
    ids.forEach((id, i) => {
      const device = queries[i]?.data
      if (device) map.set(id, deviceName(device))
    })
    return map
  }, [ids, queries, isUser, visible.data])
}
