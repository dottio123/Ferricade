import { DeviceLink } from '@/components/devices/device-link'
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertCircleIcon, ShieldCheckIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { RelativeTime } from '@/components/brand/relative-time'
import { Skeleton } from '@/components/ui/skeleton'
import { auditDeviceTarget, describeAudit } from '@/features/audit/describe'
import { useAuditDeviceNames } from '@/features/audit/use-device-names'
import { useAuditActorResolver } from '@/features/audit/actor'
import { queryKeys } from '@/lib/queryKeys'
import type { DashboardModuleSize } from '../preferences'
import { ModuleCard, ModuleEmptyState, ModuleErrorState } from './module-card'

export function AdminActivityModule({
  size = 'medium',
  isWall = false,
}: {
  size?: DashboardModuleSize
  isWall?: boolean
}) {
  const { resolveActor } = useAuditActorResolver()
  const auditQuery = useQuery({
    queryKey: queryKeys.audit.list({ limit: 50 }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/audit', {
          params: { query: { limit: 50 } },
          signal,
        }),
      ),
  })

  // Filter client-side: keep latest 10 items where actor_user_id !== null OR action === 'auth.login_failed'
  const filteredEvents = React.useMemo(() => {
    if (!auditQuery.data?.items) return []
    return auditQuery.data.items
      .filter((e) => e.actor_user_id !== null || e.action === 'auth.login_failed')
      .slice(0, 10)
  }, [auditQuery.data])

  const deviceNameMap = useAuditDeviceNames(filteredEvents)

  return (
    <ModuleCard
      title="Admin activity"
      icon={<ShieldCheckIcon className="size-4" />}
      actions={
        !isWall ? (
          <Link
            to="/audit"
            aria-label="View audit log"
            className="text-xs font-medium text-primary-text hover:underline"
          >
            View all
          </Link>
        ) : undefined
      }
      contentClassName="p-0"
    >
      {auditQuery.isLoading ? (
        <div className="flex flex-col divide-y divide-border/40 p-3 space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : auditQuery.isLoadingError ? (
        <ModuleErrorState error={auditQuery.error} retry={() => void auditQuery.refetch()} />
      ) : filteredEvents.length === 0 ? (
        <ModuleEmptyState message="No recent admin activity" />
      ) : (
        <div className="divide-y divide-border/40">
          {filteredEvents.slice(0, size === 'large' ? 8 : size === 'small' ? 3 : 4).map((event) => {
            const described = describeAudit(event)
            const { text } = described
            // The same device the names were looked up for (useAuditDeviceNames).
            const deviceId = auditDeviceTarget(event, described)
            const isFailedLogin = event.action === 'auth.login_failed'

            let targetName: string | undefined
            if (deviceId) {
              const details = event.details as Record<string, unknown> | undefined
              targetName =
                deviceNameMap.get(deviceId) ||
                (typeof details?.rustdesk_id === 'string' ? details.rustdesk_id : 'a device')
            }

            return (
              <div
                key={event.id}
                data-slot="admin-activity-item"
                className={`flex items-start justify-between px-4 py-2 hover:bg-muted/30 transition-colors ${
                  isFailedLogin ? 'bg-destructive/5' : ''
                }`}
              >
                <div className="flex items-start gap-2.5 min-w-0 pr-2">
                  {isFailedLogin ? (
                    <AlertCircleIcon className="size-4 text-destructive shrink-0 mt-0.5" />
                  ) : (
                    <div className="size-2 rounded-full bg-primary shrink-0 mt-1.5" />
                  )}

                  <div className="flex flex-col min-w-0">
                    <p className="text-xs text-foreground leading-snug">
                      <span className="font-semibold">{resolveActor(event.actor_user_id)}</span>{' '}
                      <span>{text}</span>
                      {targetName && deviceId && (
                        <>
                          {' '}
                          <DeviceLink deviceId={deviceId}>{targetName}</DeviceLink>
                        </>
                      )}
                    </p>
                    <span className="text-xs text-muted-foreground mt-0.5">
                      from {event.actor_ip}
                    </span>
                  </div>
                </div>

                <div className="shrink-0 text-xs text-muted-foreground">
                  <RelativeTime date={event.at} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </ModuleCard>
  )
}
