import * as React from 'react'
import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import { runWithConcurrency } from '@/lib/bulk'
import { useDeviceUndo } from './use-device-undo'

type Device = components['schemas']['Device']

export function useRejectDevices() {
  const { refresh, showUndo } = useDeviceUndo('reject')

  const rejectOne = React.useCallback(
    async (device: Device) => {
      const updated = await unwrap(
        api.POST('/admin/api/v1/devices/{id}/reject', { params: { path: { id: device.id } } }),
      )
      await refresh()
      showUndo([updated])
      return updated
    },
    [refresh, showUndo],
  )

  const rejectMany = React.useCallback(
    async (devices: Device[], onProgress?: (completed: number, total: number) => void) => {
      const result = await runWithConcurrency(
        devices,
        4,
        async (device) =>
          unwrap(
            api.POST('/admin/api/v1/devices/{id}/reject', { params: { path: { id: device.id } } }),
          ),
        onProgress,
      )
      if (result.success.length > 0) {
        await refresh()
        showUndo(result.success.map(({ item }) => item))
      }
      return result
    },
    [refresh, showUndo],
  )

  return { rejectOne, rejectMany, showUndo }
}
