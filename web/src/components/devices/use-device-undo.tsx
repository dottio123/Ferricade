import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { components } from '@/api/schema'
import { api, unwrap } from '@/api/client'
import { ToastAction, useToast } from '@/components/ui/toast'
import { deviceName } from '@/lib/device'
import { queryKeys } from '@/lib/queryKeys'

type Device = components['schemas']['Device']
type Action = 'approve' | 'reject'

export function useDeviceUndo(action: Action) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const refresh = React.useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.summary() }),
      ]).then(() => undefined),
    [queryClient],
  )
  const reopenMutation = useMutation({
    meta: { errorTitle: `Could not undo the ${action}` },
    mutationFn: (device: Device) =>
      unwrap(
        api.POST('/admin/api/v1/devices/{id}/reopen', { params: { path: { id: device.id } } }),
      ),
    onSuccess: refresh,
  })
  const showUndo = React.useCallback(
    (devices: Device[], description?: string) => {
      if (devices.length === 0) return
      const verb = action === 'approve' ? 'approved' : 'rejected'
      toast({
        title: devices.length === 1 ? `Device ${verb}` : `${devices.length} devices ${verb}`,
        ...(description
          ? { description }
          : devices.length === 1
            ? { description: deviceName(devices[0]!) }
            : {}),
        action: (
          <ToastAction
            altText={`Undo ${action}`}
            onClick={() => devices.forEach((device) => reopenMutation.mutate(device))}
          >
            Undo
          </ToastAction>
        ),
      })
    },
    [action, reopenMutation, toast],
  )
  return { refresh, showUndo }
}
