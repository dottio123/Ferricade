import { DeviceLink } from '@/components/devices/device-link'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { HistoryIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { RelativeTime } from '@/components/brand/relative-time'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { queryKeys } from '@/lib/queryKeys'
import type { DashboardModuleSize } from '../preferences'
import { formatDuration } from '@/lib/ticker'
import { ModuleCard, ModuleEmptyState, ModuleErrorState } from './module-card'

export function RecentSessionsModule({
  size = 'medium',
  isWall = false,
}: {
  size?: DashboardModuleSize
  isWall?: boolean
}) {
  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions.list({ active: 'false', authenticated: 'true', limit: 20 }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/sessions', {
          params: { query: { active: 'false', authenticated: 'true', limit: 20 } },
          signal,
        }),
      ),
  })

  const sessions = sessionsQuery.data?.items ?? []
  const maxItems = size === 'large' ? 8 : size === 'small' ? 3 : 4

  return (
    <ModuleCard
      title="Recent sessions"
      icon={<HistoryIcon className="size-4" />}
      actions={
        !isWall ? (
          <Link
            to="/sessions"
            aria-label="View all sessions"
            className="text-xs font-medium text-primary-text hover:underline"
          >
            View all
          </Link>
        ) : undefined
      }
      contentClassName="p-0"
    >
      {sessionsQuery.isLoading ? (
        <div className="flex flex-col divide-y divide-border/40 p-3 space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : sessionsQuery.isLoadingError ? (
        <ModuleErrorState error={sessionsQuery.error} retry={() => void sessionsQuery.refetch()} />
      ) : sessions.length === 0 ? (
        <ModuleEmptyState message="No recent sessions" />
      ) : (
        <div className="divide-y divide-border/40">
          {sessions.slice(0, maxItems).map((session) => (
            <div
              key={session.id}
              data-slot="recent-session-item"
              className="flex items-center justify-between px-4 py-2 hover:bg-muted/30 transition-colors"
            >
              <div className="flex flex-col min-w-0 pr-2">
                <div className="flex items-center gap-2 min-w-0">
                  <DeviceLink
                    deviceId={session.device_id}
                    className="text-sm truncate min-w-0 flex-1"
                  >
                    {session.device_name}
                  </DeviceLink>
                  <span className="text-xs text-muted-foreground shrink-0">↔</span>
                  <span className="text-sm text-foreground truncate min-w-0 flex-1">
                    {session.peer_name || 'Peer'}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                  <RelativeTime date={session.started_at} />
                  <span>•</span>
                  <Badge variant="outline" className="text-2xs px-1 py-0 h-4 capitalize">
                    {session.type.replace('_', ' ')}
                  </Badge>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs font-mono tabular-nums text-muted-foreground">
                  {formatDuration(session.duration_seconds)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </ModuleCard>
  )
}
