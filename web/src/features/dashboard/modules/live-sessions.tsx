import { DeviceLink } from '@/components/devices/device-link'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { RadioIcon, TimerIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { MonoId } from '@/components/brand/mono-id'
import { Badge } from '@/components/ui/badge'
import { DisconnectSession } from '@/components/sessions/disconnect-session'
import { Skeleton } from '@/components/ui/skeleton'
import { useSharedTicker } from '@/lib/ticker'
import { queryKeys } from '@/lib/queryKeys'
import { cn } from '@/lib/utils'
import type { DashboardModuleSize } from '../preferences'
import { useWallFit } from '../use-wall-fit'
import { ModuleCard, ModuleEmptyState, ModuleErrorState } from './module-card'

function formatElapsed(startedAt: string, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
  const hrs = Math.floor(elapsedSeconds / 3600)
  const mins = Math.floor((elapsedSeconds % 3600) / 60)
  const secs = elapsedSeconds % 60

  if (hrs > 0) {
    return `${hrs}h ${mins.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`
  }
  return `${mins}m ${secs.toString().padStart(2, '0')}s`
}

export function LiveSessionsModule({
  size = 'medium',
  isWall = false,
}: {
  size?: DashboardModuleSize
  isWall?: boolean
}) {
  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions.list({ active: 'true', authenticated: 'true' }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/sessions', {
          params: { query: { active: 'true', authenticated: 'true' } },
          signal,
        }),
      ),
  })

  // Shared 1-second clock across all active sessions
  const now = useSharedTicker()

  const sessions = sessionsQuery.data?.items ?? []
  const count = sessions.length
  const defaultMax = size === 'large' ? 8 : size === 'small' ? 2 : 4

  const { containerRef, listRef, visibleCount, hiddenCount } = useWallFit({
    isWall,
    count,
    defaultMax,
  })

  const visibleItems = sessions.slice(0, visibleCount)

  return (
    <ModuleCard
      title="Live sessions"
      icon={<RadioIcon className="size-4" />}
      badge={
        count > 0 ? (
          <Badge
            variant="outline"
            className="text-xs font-mono bg-primary/10 text-primary-text border-primary/30"
          >
            {count}
          </Badge>
        ) : undefined
      }
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
      ) : count === 0 ? (
        <ModuleEmptyState message="No active sessions" />
      ) : (
        <div
          ref={containerRef}
          className={cn(
            'flex flex-col h-full',
            isWall && 'min-h-0 overflow-hidden justify-between',
          )}
        >
          <div ref={listRef} className="divide-y divide-border/40">
            {visibleItems.map((session) => {
              const elapsed = formatElapsed(session.started_at, now)

              return (
                <div
                  key={session.id}
                  data-slot="live-session-item"
                  data-session-id={session.id}
                  className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 px-4 py-2 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex flex-col min-w-0 flex-1 basis-40">
                    <div data-slot="wall-row-primary" className="flex items-center gap-2 min-w-0">
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
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5 min-w-0">
                      {session.peer_rustdesk_id && (
                        <MonoId
                          idText={session.peer_rustdesk_id}
                          className="max-w-full text-left [overflow-wrap:anywhere]"
                        />
                      )}
                      <Badge variant="outline" className="text-2xs px-1 py-0 h-4 capitalize">
                        {session.type.replace('_', ' ')}
                      </Badge>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <DisconnectSession session={session} compact />
                    <div className="flex items-center gap-1 text-xs font-mono tabular-nums text-primary-text font-medium bg-primary/10 px-2 py-1 rounded-md">
                      <TimerIcon className="size-3" />
                      <span>{elapsed}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          {isWall && hiddenCount > 0 && (
            <Link
              to="/sessions"
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
