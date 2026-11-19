import { DeviceLink } from '@/components/devices/device-link'
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { BarChart3Icon } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, unwrap } from '@/api/client'
import { Skeleton } from '@/components/ui/skeleton'
import { queryKeys } from '@/lib/queryKeys'
import type { DashboardModuleSize } from '../preferences'
import { formatDuration } from '@/lib/ticker'
import { ModuleCard, ModuleEmptyState, ModuleErrorState } from './module-card'

export function SessionAnalyticsModule({ size = 'medium' }: { size?: DashboardModuleSize }) {
  void size
  const detectedTz = React.useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
      return 'UTC'
    }
  }, [])

  const statsQuery = useQuery({
    queryKey: queryKeys.sessionStats({ range: '7d', tz: detectedTz }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/sessions/stats', {
          params: { query: { range: '7d', tz: detectedTz } },
          signal,
        }),
      ),
  })

  const stats = statsQuery.data
  const perDay = React.useMemo(() => {
    if (!stats?.per_day) return []
    return stats.per_day.map((d) => ({
      day: d.day.slice(5), // MM-DD
      count: d.count,
    }))
  }, [stats])

  const topDevices = stats?.top_devices ?? []

  return (
    <ModuleCard
      title="Session analytics"
      icon={<BarChart3Icon className="size-4" />}
      badge={<span className="text-xs text-muted-foreground font-mono">Last 7d</span>}
    >
      {statsQuery.isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : statsQuery.isLoadingError ? (
        <ModuleErrorState error={statsQuery.error} retry={() => void statsQuery.refetch()} />
      ) : !stats || stats.per_day.length === 0 ? (
        <ModuleEmptyState message="No session statistics for this period" />
      ) : (
        <div className="flex flex-col gap-2.5 h-full">
          {/* Average Duration KPI */}
          <div className="flex items-center justify-between border-b border-border/40 pb-1.5 shrink-0">
            <span className="text-xs font-medium text-muted-foreground">
              Average session duration
            </span>
            <span className="text-lg font-bold tabular-nums text-foreground">
              {formatDuration(stats.average_seconds)}
            </span>
          </div>

          {/* Daily sessions bar chart */}
          <div className="flex-1 min-h-[96px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={perDay}
                margin={{ top: 5, right: 5, left: -25, bottom: 0 }}
                aria-hidden="true"
                tabIndex={-1}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.2} />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--card)',
                    borderColor: 'var(--border)',
                    borderRadius: '6px',
                    fontSize: '11px',
                    color: 'var(--foreground)',
                  }}
                />
                <Bar dataKey="count" name="Sessions" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <table className="sr-only">
            <caption>Sessions per day, last 7 days</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {perDay.map((day) => (
                <tr key={day.day}>
                  <th scope="row">{day.day}</th>
                  <td>{day.count}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Top Devices */}
          {topDevices.length > 0 && (
            <div className="flex flex-col gap-1 pt-1 border-t border-border/40 shrink-0">
              <span className="text-xs font-medium text-muted-foreground">Most active devices</span>
              <div className="flex flex-col gap-1">
                {topDevices.slice(0, 3).map((d) => (
                  <div
                    key={d.device_id}
                    className="flex items-center justify-between text-xs gap-2 min-w-0"
                  >
                    <DeviceLink deviceId={d.device_id} className="truncate min-w-0 flex-1">
                      {d.device_name}
                    </DeviceLink>
                    <span className="text-muted-foreground tabular-nums shrink-0">
                      {d.count} sessions ({formatDuration(d.total_seconds)})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </ModuleCard>
  )
}
