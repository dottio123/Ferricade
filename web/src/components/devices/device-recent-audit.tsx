import type { UseQueryResult } from '@tanstack/react-query'
import type { components } from '@/api/schema'
import { describeError } from '@/api/errors'
import { Skeleton } from '@/components/ui/skeleton'
import { AuditTimeline, type AuditTimelineProps } from '@/components/audit/audit-timeline'

export function DeviceRecentAudit({
  auditQuery,
  resolveActor,
}: {
  resolveActor: AuditTimelineProps['resolveActor']
  auditQuery: UseQueryResult<{ items: components['schemas']['AuditEvent'][] }, Error>
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Recent Audit Log</h3>
      {auditQuery.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : auditQuery.isLoadingError ? (
        <p role="alert" className="text-xs text-destructive">
          Could not load the audit entries: {describeError(auditQuery.error).message}
        </p>
      ) : auditQuery.data?.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">No audit entries recorded for this device.</p>
      ) : (
        <AuditTimeline
          events={auditQuery.data?.items ?? []}
          resolveActor={resolveActor}
          isOwner={false}
          compact
        />
      )}
    </div>
  )
}
