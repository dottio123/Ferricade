import { DeviceLink } from '@/components/devices/device-link'
import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ShieldAlertIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import { describeError } from '@/api/errors'
import { MonoId } from '@/components/brand/mono-id'
import { RelativeTime } from '@/components/brand/relative-time'
import { StatusDot } from '@/components/brand/status-dot'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { queryKeys } from '@/lib/queryKeys'
import { summaryQueryOptions } from '@/lib/queries'
import type { DashboardModuleSize } from '../preferences'
import { ModuleCard, ModuleEmptyState, ModuleErrorState } from './module-card'
import { deviceName } from '@/lib/device'
import { ApproveRejectActions } from '@/components/devices/approve-reject-actions'
import { useRejectDevices } from '@/components/devices/use-reject-devices'
import { useApproveDevices } from '@/components/devices/use-approve-devices'
import { useApprovedHold } from '@/components/devices/use-approved-hold'

export function ApprovalQueueModule({
  size = 'medium',
  isWall = false,
}: {
  size?: DashboardModuleSize
  isWall?: boolean
}) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const approveDevices = useApproveDevices()
  const approvedHold = useApprovedHold()

  const summaryQuery = useQuery(summaryQueryOptions)

  const pendingQuery = useQuery({
    queryKey: queryKeys.devices.list({ state: 'pending', limit: 10 }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/devices', {
          params: { query: { state: 'pending', limit: 10 } },
          signal,
        }),
      ),
  })

  const [operatingId, setOperatingId] = React.useState<string | null>(null)

  const approveMutation = useMutation({
    mutationFn: async (device: components['schemas']['Device']) => {
      const result = await approveDevices.approve([device], undefined, (approved) => {
        for (const item of approved)
          approvedHold.hold(
            item,
            devices.findIndex((d) => d.id === item.id),
          )
      })
      if (result.failed.length) throw result.failed[0]!.error
    },
    onMutate: (device) => setOperatingId(device.id),
    onError: (err) => {
      toast({
        title: 'Failed to approve',
        description: describeError(err).message,
        variant: 'destructive',
      })
    },
    onSettled: () => setOperatingId(null),
  })

  const rejectDevices = useRejectDevices()
  const rejectMutation = useMutation({
    meta: { errorTitle: 'Could not reject the device' },
    mutationFn: (device: components['schemas']['Device']) => rejectDevices.rejectOne(device),
    onMutate: (device) => setOperatingId(device.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
    },
    onError: (err) => {
      toast({
        title: 'Failed to reject',
        description: describeError(err).message,
        variant: 'destructive',
      })
    },
    onSettled: () => setOperatingId(null),
  })

  const devices = approvedHold.visible(pendingQuery.data?.items ?? [])
  const pendingTotal = summaryQuery.data?.devices.pending ?? devices.length

  return (
    <ModuleCard
      title="Approval queue"
      icon={<ShieldAlertIcon className="size-4" />}
      badge={
        pendingTotal > 0 ? (
          <Badge
            variant="outline"
            className="text-xs font-mono bg-status-pending/10 text-status-pending border-status-pending/30"
          >
            {pendingTotal}
          </Badge>
        ) : undefined
      }
      actions={
        !isWall ? (
          <Link
            to="/devices/queue"
            aria-label="View approval queue"
            className="text-xs font-medium text-primary hover:underline"
          >
            View all
          </Link>
        ) : undefined
      }
      contentClassName="p-0"
    >
      {pendingQuery.isLoading ? (
        <div className="flex flex-col divide-y divide-border/40 p-3 space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : pendingQuery.isLoadingError ? (
        <ModuleErrorState error={pendingQuery.error} retry={() => void pendingQuery.refetch()} />
      ) : devices.length === 0 ? (
        <ModuleEmptyState message="No devices waiting for approval" />
      ) : (
        <div className="divide-y divide-border/40">
          {devices.slice(0, size === 'large' ? 8 : size === 'small' ? 3 : 4).map((device) => {
            const isPendingAction = operatingId === device.id
            const name = deviceName(device)

            return (
              <div
                key={device.id}
                data-slot="queue-item"
                data-device-id={device.id}
                className="flex items-center justify-between px-4 py-2 hover:bg-muted/30 transition-colors"
              >
                <div className="flex flex-col min-w-0 pr-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusDot status={device.online ? 'online' : 'offline'} size="sm" />
                    <DeviceLink
                      deviceId={device.id}
                      className="text-sm truncate min-w-0 font-medium"
                    >
                      {name}
                    </DeviceLink>
                    <MonoId idText={device.rustdesk_id} />
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5 truncate">
                    {device.username && (
                      <span data-slot="queue-item-username">user: {device.username}</span>
                    )}
                    {device.hostname && device.alias && <span>({device.hostname})</span>}
                    <span>
                      · Seen <RelativeTime date={device.first_seen_at} />
                    </span>
                  </div>
                </div>

                <div className="flex items-center shrink-0">
                  {approvedHold.isHeld(device.id) ? (
                    <span role="status" className="text-xs">
                      Approved
                    </span>
                  ) : (
                    <ApproveRejectActions
                      onApprove={() => approveMutation.mutate(device)}
                      onReject={() => rejectMutation.mutate(device)}
                      isApproving={
                        approveMutation.isPending && approveMutation.variables?.id === device.id
                      }
                      isRejecting={
                        rejectMutation.isPending && rejectMutation.variables?.id === device.id
                      }
                      disabled={isPendingAction}
                      approveAriaLabel={`Approve ${name}`}
                      rejectAriaLabel={`Reject ${name}`}
                      size="sm"
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </ModuleCard>
  )
}
