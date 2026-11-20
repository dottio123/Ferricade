import * as React from 'react'
import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import { runWithConcurrency } from '@/lib/bulk'
import { openGroupConflictDialog } from './group-conflict-dialog'
import { useDeviceUndo } from './use-device-undo'

type Device = components['schemas']['Device']

export interface ApproveOptions {
  suppressConflictDialog?: boolean
}

export function useApproveDevices() {
  const { refresh, showUndo } = useDeviceUndo('approve')

  const approve = React.useCallback(
    async (
      devices: Device[],
      onProgress?: (completed: number, total: number) => void,
      onApproved?: (devices: Device[]) => void,
      options?: ApproveOptions,
    ) => {
      const result = await runWithConcurrency(
        devices,
        4,
        (device) =>
          unwrap(
            api.POST('/admin/api/v1/devices/{id}/approve', {
              params: { path: { id: device.id } },
            }),
          ),
        onProgress,
      )
      if (result.success.length > 0) {
        await refresh()
        const approved = result.success.map(({ item }) => item)
        onApproved?.(approved)

        const placedCount = result.success.filter(
          ({ result: d, item: before }) => Boolean(d?.group_id) && !before.group_id,
        ).length
        const needChoiceCount = result.success.filter(({ result: d }) =>
          Boolean(d?.open_alerts?.some((a) => a.kind === 'group_conflict')),
        ).length
        const groupMessage = `${placedCount} placed in groups, ${needChoiceCount} need a group choice`

        showUndo(approved, approved.length === 1 ? undefined : groupMessage)

        if (
          devices.length === 1 &&
          result.success.length === 1 &&
          !options?.suppressConflictDialog
        ) {
          const updated = result.success[0]!.result
          const conflict = updated.open_alerts?.find((a) => a.kind === 'group_conflict')
          if (conflict) {
            openGroupConflictDialog({ deviceId: updated.id, initialDevice: updated })
          }
        }
      }
      return result
    },
    [refresh, showUndo],
  )

  return { approve }
}
