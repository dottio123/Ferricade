import { DeviceLink } from '@/components/devices/device-link'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AlertTriangleIcon,
  ClockIcon,
  HelpCircleIcon,
  ShieldAlertIcon,
  WifiOffIcon,
} from 'lucide-react'
import { MonoId } from '@/components/brand/mono-id'
import { RelativeTime } from '@/components/brand/relative-time'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { summaryQueryOptions } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { openGroupConflictDialog } from '@/components/devices/group-conflict-dialog'
import type { DashboardModuleSize } from '../preferences'
import { useWallFit } from '../use-wall-fit'
import { ModuleCard, ModuleEmptyState, ModuleErrorState } from './module-card'

type AttentionKind =
  | 'uuid_mismatch'
  | 'access_window_unconfirmed'
  | 'group_conflict'
  | 'pending_long'
  | 'offline_long'
  | 'outdated_client'

function getKindConfig(kind: AttentionKind) {
  switch (kind) {
    case 'uuid_mismatch':
      return {
        label: 'UUID mismatch',
        icon: <ShieldAlertIcon className="size-3.5 text-status-alert" />,
        variant: 'alert' as const,
      }
    case 'access_window_unconfirmed':
      return {
        label: 'Access window not confirmed closed',
        icon: <ShieldAlertIcon className="size-3.5 text-status-alert" />,
        variant: 'alert' as const,
      }
    case 'group_conflict':
      return {
        label: 'Group conflict',
        icon: <ShieldAlertIcon className="size-3.5 text-status-alert" />,
        variant: 'alert' as const,
      }
    case 'pending_long':
      return {
        label: 'Pending long',
        icon: <ClockIcon className="size-3.5 text-status-pending" />,
        variant: 'pending' as const,
      }
    case 'offline_long':
      return {
        label: 'Long offline',
        icon: <WifiOffIcon className="size-3.5 text-muted-foreground" />,
        variant: 'offline' as const,
      }
    case 'outdated_client':
      return {
        label: 'Outdated client',
        icon: <AlertTriangleIcon className="size-3.5 text-status-pending" />,
        variant: 'pending' as const,
      }
    default:
      return {
        label: 'Alert',
        icon: <HelpCircleIcon className="size-3.5 text-muted-foreground" />,
        variant: 'outline' as const,
      }
  }
}

export function NeedsAttentionModule({
  size = 'medium',
  isWall = false,
}: {
  size?: DashboardModuleSize
  isWall?: boolean
}) {
  const summaryQuery = useQuery(summaryQueryOptions)

  const attentionItems = summaryQuery.data?.attention ?? []
  const count = attentionItems.length
  const defaultMax = size === 'large' ? 8 : size === 'small' ? 3 : 4

  const { containerRef, listRef, visibleCount, hiddenCount } = useWallFit({
    isWall,
    count,
    defaultMax,
  })

  const visibleItems = attentionItems.slice(0, visibleCount)

  return (
    <ModuleCard
      title="Needs attention"
      icon={<AlertTriangleIcon className="size-4" />}
      badge={
        count > 0 ? (
          <Badge variant="pending" className="text-xs font-mono">
            {count}
          </Badge>
        ) : undefined
      }
      actions={
        !isWall ? (
          <Link
            to="/devices"
            aria-label="View all devices"
            className="text-xs font-medium text-primary hover:underline"
          >
            View all
          </Link>
        ) : undefined
      }
      contentClassName="p-0"
    >
      {summaryQuery.isLoading ? (
        <div className="flex flex-col divide-y divide-border/40 p-3 space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : summaryQuery.isLoadingError ? (
        <ModuleErrorState error={summaryQuery.error} retry={() => void summaryQuery.refetch()} />
      ) : attentionItems.length === 0 ? (
        <ModuleEmptyState message="All systems normal — no devices need attention" />
      ) : (
        <div
          ref={containerRef}
          className={cn(
            'flex flex-col h-full',
            isWall && 'min-h-0 overflow-hidden justify-between',
          )}
        >
          <div ref={listRef} className="divide-y divide-border/40">
            {visibleItems.map((item, idx) => {
              const config = getKindConfig(item.kind)
              const isConflict = item.kind === 'group_conflict'

              const innerContent = (
                <>
                  <div className="flex flex-col min-w-0 pr-3">
                    <div data-slot="wall-row-primary" className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors truncate min-w-0 flex-1">
                        {item.name}
                      </span>
                      <MonoId idText={item.rustdesk_id} />
                    </div>
                    <span className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                      {item.detail}
                    </span>
                  </div>

                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge variant={config.variant} className="text-2xs px-1.5 py-0 h-4.5 gap-1">
                      {config.icon}
                      <span>{config.label}</span>
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      <RelativeTime date={item.since} />
                    </span>
                  </div>
                </>
              )

              if (isConflict) {
                return (
                  <div
                    key={`${item.device_id}-${item.kind}-${idx}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => openGroupConflictDialog({ deviceId: item.device_id })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openGroupConflictDialog({ deviceId: item.device_id })
                      }
                    }}
                    className="flex items-start justify-between px-4 py-2 hover:bg-muted/30 transition-colors group text-inherit cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {innerContent}
                  </div>
                )
              }

              return (
                <DeviceLink
                  key={`${item.device_id}-${item.kind}-${idx}`}
                  deviceId={item.device_id}
                  className="flex items-start justify-between px-4 py-2 hover:bg-muted/30 transition-colors group text-inherit"
                >
                  {innerContent}
                </DeviceLink>
              )
            })}
          </div>
          {isWall && hiddenCount > 0 && (
            <Link
              to="/devices"
              data-slot="wall-more"
              className="block py-1 px-4 text-center border-t border-border/40 text-muted-foreground hover:text-foreground font-medium text-sm transition-colors"
            >
              +{hiddenCount} more
            </Link>
          )}
        </div>
      )}
    </ModuleCard>
  )
}
