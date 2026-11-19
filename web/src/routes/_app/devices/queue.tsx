import * as React from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { MonitorIcon, UserIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import { EmptyState } from '@/components/brand/empty-state'
import { ErrorState } from '@/components/brand/error-state'
import { MonoId } from '@/components/brand/mono-id'
import { RelativeTime } from '@/components/brand/relative-time'
import { StatusDot } from '@/components/brand/status-dot'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { queryKeys } from '@/lib/queryKeys'
import { cn } from '@/lib/utils'
import { deviceName } from '@/lib/device'
import { ApproveRejectActions } from '@/components/devices/approve-reject-actions'
import { useRejectDevices } from '@/components/devices/use-reject-devices'
import { useApproveDevices } from '@/components/devices/use-approve-devices'
import { useApprovedHold } from '@/components/devices/use-approved-hold'
import { BulkActionBar } from '@/components/devices/bulk-action-bar'

export const Route = createFileRoute('/_app/devices/queue')({
  component: DevicesQueuePage,
})

type Device = components['schemas']['Device']

function DevicesQueuePage() {
  const queryClient = useQueryClient()
  const rejectDevices = useRejectDevices()
  const approveDevices = useApproveDevices()
  const approvedHold = useApprovedHold()

  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [isBulkRunning, setIsBulkRunning] = React.useState(false)

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: queryKeys.devices.infinite({ state: 'pending', limit: 200 }),
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      unwrap(
        api.GET('/admin/api/v1/devices', {
          params: {
            query: {
              state: 'pending',
              limit: 200,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.next_cursor || undefined,
  })

  // Approve single device mutation
  const approveMutation = useMutation({
    meta: { errorTitle: 'Could not approve the device' },
    mutationFn: async (device: Device) => {
      const result = await approveDevices.approve([device], undefined, (approved) => {
        for (const item of approved)
          approvedHold.hold(
            item,
            devices.findIndex((d) => d.id === item.id),
          )
      })
      if (result.failed.length) throw result.failed[0]!.error
      return result.success[0]!.result
    },
  })

  // Reject single device mutation
  const rejectMutation = useMutation({
    meta: { errorTitle: 'Could not reject the device' },
    mutationFn: (device: Device) => rejectDevices.rejectOne(device),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
    },
  })

  const pendingDevices: Device[] = data?.pages.flatMap((p) => p.items) ?? []
  const devices = approvedHold.visible(pendingDevices)

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected =
    pendingDevices.length > 0 && pendingDevices.every((d) => selectedIds.has(d.id))
  const handleToggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(pendingDevices.map((d) => d.id)))
    }
  }

  const selectedDevices = pendingDevices.filter((d) => selectedIds.has(d.id))

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Approval Queue"
        description="Devices requesting access to the network. Approve or reject incoming enrollments."
      />

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={`skeleton-${i}`} className="animate-pulse border-border">
              <CardHeader className="h-20 bg-muted/30" />
              <CardContent className="h-32" />
            </Card>
          ))}
        </div>
      ) : isError ? (
        <ErrorState error={error} retry={() => void refetch()} />
      ) : devices.length === 0 ? (
        <EmptyState title="No devices are waiting for approval." />
      ) : (
        <div className="flex flex-col gap-4">
          {/* Queue Bulk Actions Toolbar */}
          <BulkActionBar
            selectedDevices={selectedDevices}
            tags={[]}
            onClearSelection={() => setSelectedIds(new Set())}
            queue={{
              devices: pendingDevices,
              selectedCount: selectedIds.size,
              allSelected,
              onToggleSelectAll: handleToggleSelectAll,
              onRunningChange: setIsBulkRunning,
            }}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {devices.map((device) => {
              const isApproving =
                approveMutation.isPending && approveMutation.variables?.id === device.id
              const isApproved = approvedHold.isHeld(device.id)
              const isRejecting =
                rejectMutation.isPending && rejectMutation.variables?.id === device.id
              const isBusy = isApproving || isRejecting || isBulkRunning
              const isSelected = selectedIds.has(device.id)

              return (
                <Card
                  key={device.id}
                  data-device-id={device.id}
                  className={cn(
                    'flex flex-col justify-between border-border bg-card shadow-xs transition-shadow hover:shadow-sm',
                    isSelected && 'ring-2 ring-primary border-primary/50',
                  )}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <input
                          type="checkbox"
                          aria-label={`Select device ${deviceName(device)}`}
                          checked={isSelected}
                          onChange={() => handleToggleSelect(device.id)}
                          disabled={isBulkRunning || isApproved}
                          className="mt-1 size-4 rounded border-input text-primary focus:ring-ring cursor-pointer shrink-0"
                        />
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <CardTitle className="text-sm font-semibold text-foreground truncate">
                              {deviceName(device)}
                            </CardTitle>
                            <div className="inline-flex items-center gap-1 shrink-0 text-xs text-muted-foreground font-normal">
                              <StatusDot status={device.online ? 'online' : 'offline'} size="sm" />
                              <span className="capitalize">
                                {device.online ? 'Online' : 'Offline'}
                              </span>
                            </div>
                          </div>
                          {device.alias && device.hostname && (
                            <span className="text-xs text-muted-foreground truncate">
                              {device.hostname}
                            </span>
                          )}
                        </div>
                      </div>
                      <MonoId idText={device.rustdesk_id} />
                    </div>
                  </CardHeader>

                  <CardContent className="flex flex-col gap-2.5 text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <UserIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span
                        data-slot="queue-card-username"
                        className="truncate font-medium text-foreground"
                      >
                        {device.username ? `OS user: ${device.username}` : 'No OS user reported'}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {device.os} {device.client_version ? `(v${device.client_version})` : ''}
                      </span>
                    </div>

                    {(device.cpu || device.memory) && (
                      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground/80 truncate">
                        {device.cpu && <span className="truncate">{device.cpu}</span>}
                        {device.cpu && device.memory && <span>·</span>}
                        {device.memory && <span>{device.memory}</span>}
                      </div>
                    )}

                    <div className="mt-1 flex items-center justify-between text-xs border-t border-border/50 pt-2">
                      <span>First seen:</span>
                      <RelativeTime date={device.first_seen_at} />
                    </div>
                  </CardContent>

                  <CardFooter className="flex gap-2 pt-2 border-t border-border">
                    {isApproved ? (
                      <span role="status" className="text-sm font-medium text-status-online">
                        Approved
                      </span>
                    ) : (
                      <ApproveRejectActions
                        layout="card"
                        onApprove={() => approveMutation.mutate(device)}
                        onReject={() => rejectMutation.mutate(device)}
                        isApproving={isApproving}
                        isRejecting={isRejecting}
                        disabled={isBusy}
                        approveAriaLabel={`Approve ${deviceName(device)}`}
                        rejectAriaLabel={`Reject ${deviceName(device)}`}
                        className="w-full"
                      />
                    )}
                  </CardFooter>
                </Card>
              )
            })}
          </div>

          {hasNextPage && (
            <div className="flex justify-center py-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Loading more…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
