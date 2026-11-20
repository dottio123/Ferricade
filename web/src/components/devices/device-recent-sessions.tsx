import type { UseQueryResult } from '@tanstack/react-query'
import type { components } from '@/api/schema'
import { describeError } from '@/api/errors'
import { Skeleton } from '@/components/ui/skeleton'
import { RelativeTime } from '@/components/brand/relative-time'
import { Badge } from '@/components/ui/badge'
import { DISCONNECTED_LABEL, DisconnectSession } from '@/components/sessions/disconnect-session'
import { formatDuration } from '@/lib/ticker'
import { sessionKindLabel } from '@/lib/session-kind'

export function DeviceRecentSessions({
  sessionsQuery,
}: {
  sessionsQuery: UseQueryResult<{ items: components['schemas']['RemoteSession'][] }, Error>
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Recent Remote Sessions</h3>
      {sessionsQuery.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : sessionsQuery.isLoadingError ? (
        <p role="alert" className="text-xs text-destructive">
          Could not load the sessions: {describeError(sessionsQuery.error).message}
        </p>
      ) : sessionsQuery.data?.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No remote sessions recorded for this device.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-1.5 font-medium">Peer</th>
                <th className="py-1.5 font-medium">Type</th>
                <th className="py-1.5 font-medium">Started</th>
                <th className="py-1.5 font-medium text-right">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {sessionsQuery.data?.items.map((s) => (
                <tr
                  key={s.id}
                  data-slot="device-session-row"
                  data-session-id={s.id}
                  className="hover:bg-muted/30"
                >
                  <td className="py-1.5 font-medium text-foreground">
                    {s.peer_name || s.peer_rustdesk_id || '—'}
                  </td>
                  <td className="py-1.5">
                    <Badge variant="outline" className="text-2xs py-0 px-1">
                      {sessionKindLabel(s.type)}
                    </Badge>
                  </td>
                  <td className="py-1.5 text-muted-foreground">
                    <RelativeTime date={s.started_at} />
                  </td>
                  <td className="py-1.5 text-right font-mono">
                    {s.ended_at === null ? (
                      <span className="inline-flex items-center justify-end gap-2">
                        <DisconnectSession session={s} compact />
                        <span className="text-status-online font-semibold">Open</span>
                      </span>
                    ) : (
                      <span
                        title={s.end_reason === 'disconnected' ? DISCONNECTED_LABEL : undefined}
                      >
                        {formatDuration(s.duration_seconds)}
                        {s.end_reason === 'disconnected' && (
                          <span className="ml-1.5 font-sans text-muted-foreground">
                            {DISCONNECTED_LABEL}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
