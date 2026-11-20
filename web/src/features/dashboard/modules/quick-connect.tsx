import { DeviceLink } from '@/components/devices/device-link'
import * as React from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ExternalLinkIcon, PinIcon, StarIcon, ZapIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { useMe } from '@/auth/session'
import { MonoId } from '@/components/brand/mono-id'
import { StatusDot } from '@/components/brand/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConnectLink } from '@/hooks/use-connect-link'
import { useToast } from '@/components/ui/toast'
import { queryKeys } from '@/lib/queryKeys'
import { cn } from '@/lib/utils'
import { PIN_LIMIT, type DashboardModuleSize } from '../preferences'
import { useDashboardPreferences, useUpdatePreferences } from '../use-preferences'
import { ModuleCard, ModuleEmptyState, ModuleErrorState } from './module-card'
import { deviceName } from '@/lib/device'

export function QuickConnectModule({
  size = 'medium',
  isWall = false,
}: {
  size?: DashboardModuleSize
  isWall?: boolean
}) {
  const me = useMe().data
  const { preferences } = useDashboardPreferences()
  const { togglePin } = useUpdatePreferences()
  const {
    connect,
    isLoading: isConnecting,
    result: connectResult,
    error: connectError,
    clearError,
  } = useConnectLink()
  const { toast } = useToast()

  // A failed connect must say so; the hook keeps the message until cleared.
  React.useEffect(() => {
    if (!connectError) return
    toast({ title: 'Could not connect', description: connectError, variant: 'destructive' })
    clearError()
  }, [connectError, clearError, toast])

  const pinnedIds = React.useMemo(
    () => preferences?.pinned_device_ids ?? [],
    [preferences?.pinned_device_ids],
  )

  // Fetch recent connects by this admin
  const auditQuery = useQuery({
    queryKey: queryKeys.audit.list({
      actor: me?.user.id,
      action: 'device.connect_link',
      limit: 20,
    }),
    enabled: Boolean(me?.user.id),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/audit', {
          params: {
            query: {
              actor: me!.user.id,
              action: 'device.connect_link',
              limit: 20,
            },
          },
          signal,
        }),
      ),
  })

  // Deduplicate recent target devices (up to 6 unique)
  const recentIds = React.useMemo(() => {
    if (!auditQuery.data?.items) return []
    const seen = new Set<string>(pinnedIds)
    const list: string[] = []
    for (const item of auditQuery.data.items) {
      if (item.target_id && !seen.has(item.target_id)) {
        seen.add(item.target_id)
        list.push(item.target_id)
        if (list.length >= 6) break
      }
    }
    return list
  }, [auditQuery.data, pinnedIds])

  // Combine pinned + recent targets
  const allTargetIds = React.useMemo(() => [...pinnedIds, ...recentIds], [pinnedIds, recentIds])

  // Fetch device details in parallel
  const deviceQueries = useQueries({
    queries: allTargetIds.map((id) => ({
      queryKey: queryKeys.device(id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        unwrap(api.GET('/admin/api/v1/devices/{id}', { params: { path: { id } }, signal })),
      staleTime: 30_000,
    })),
  })

  const [connectingDeviceId, setConnectingDeviceId] = React.useState<string | null>(null)

  const handleConnect = async (deviceId: string) => {
    setConnectingDeviceId(deviceId)
    await connect(deviceId)
    setConnectingDeviceId(null)
  }

  const isLoading =
    auditQuery.isLoading || (allTargetIds.length > 0 && deviceQueries.some((q) => q.isLoading))
  const isPinLimitReached = pinnedIds.length >= PIN_LIMIT

  return (
    <ModuleCard
      title="Quick connect"
      icon={<ZapIcon className="size-4" />}
      badge={
        allTargetIds.length > 0 ? (
          <Badge variant="outline" className="text-xs font-mono">
            {allTargetIds.length}
          </Badge>
        ) : undefined
      }
      actions={
        !isWall ? (
          <Link
            to="/devices"
            aria-label="View all devices"
            className="text-xs font-medium text-primary-text hover:underline"
          >
            View all
          </Link>
        ) : undefined
      }
      contentClassName="p-0"
    >
      {/* Show Open in RustDesk link banner if a connect URL was returned */}
      {connectResult && (
        <div className="bg-primary/10 border-b border-border/60 px-4 py-2 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Connected to client</span>
          <a
            href={connectResult.url}
            className="text-primary-text hover:underline font-semibold inline-flex items-center gap-1"
          >
            <span>Open in RustDesk</span>
            <ExternalLinkIcon className="size-3" />
          </a>
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-col divide-y divide-border/40 p-3 space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : auditQuery.isLoadingError && pinnedIds.length === 0 ? (
        <ModuleErrorState error={auditQuery.error} retry={() => void auditQuery.refetch()} />
      ) : allTargetIds.length === 0 ? (
        <ModuleEmptyState message="No pinned or recent devices. Pin devices to connect quickly." />
      ) : (
        <div className="divide-y divide-border/40">
          {allTargetIds
            .slice(0, size === 'large' ? 8 : size === 'small' ? 3 : 4)
            .map((id, index) => {
              const dev = deviceQueries[index]?.data
              const isPinned = pinnedIds.includes(id)
              const name = dev ? deviceName(dev) : 'Device'
              const isConnectingThis = isConnecting && connectingDeviceId === id
              const isOffline = dev ? !dev.online : false

              return (
                <div
                  key={id}
                  data-slot="quick-connect-item"
                  data-offline={isOffline ? 'true' : undefined}
                  className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/30 transition-colors"
                >
                  <div
                    className={cn(
                      'flex items-center gap-2.5 min-w-0 pr-2',
                      isOffline && 'opacity-60',
                    )}
                  >
                    <StatusDot
                      status={
                        dev?.online ? 'online' : dev?.state === 'pending' ? 'pending' : 'offline'
                      }
                    />
                    <div className="flex flex-col min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <DeviceLink deviceId={id} className="text-sm truncate min-w-0 flex-1">
                          {name}
                        </DeviceLink>
                        {dev && <MonoId idText={dev.rustdesk_id} />}
                        {isOffline && (
                          <Badge
                            variant="outline"
                            className="text-2xs px-1 py-0 h-4 text-muted-foreground border-border/60"
                          >
                            Offline
                          </Badge>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        {isPinned ? (
                          <>
                            <PinIcon className="size-2.5 text-status-pending inline" /> Pinned
                          </>
                        ) : (
                          'Recent'
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          disabled={!isPinned && isPinLimitReached}
                          onClick={() => togglePin(id)}
                          aria-label={isPinned ? `Unpin ${name}` : `Pin ${name}`}
                        >
                          <StarIcon
                            className={`size-3.5 ${
                              isPinned
                                ? 'text-status-pending fill-status-pending'
                                : 'text-muted-foreground hover:text-status-pending'
                            }`}
                          />
                        </Button>
                      </TooltipTrigger>
                      {!isPinned && isPinLimitReached && (
                        <TooltipContent>You can pin up to {PIN_LIMIT} devices.</TooltipContent>
                      )}
                    </Tooltip>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs gap-1"
                      disabled={isConnectingThis}
                      onClick={() => handleConnect(id)}
                      aria-label={`Connect to ${name}`}
                    >
                      <ExternalLinkIcon className="size-3" />
                      <span>{isConnectingThis ? 'Connecting...' : 'Connect'}</span>
                    </Button>
                  </div>
                </div>
              )
            })}
        </div>
      )}
    </ModuleCard>
  )
}
