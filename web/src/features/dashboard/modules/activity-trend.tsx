import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { TrendingUpIcon } from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api, unwrap } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { queryKeys, type HistoryRange } from '@/lib/queryKeys'
import { cn } from '@/lib/utils'
import type { DashboardModuleSize } from '../preferences'
import { ModuleCard, ModuleEmptyState, ModuleErrorState } from './module-card'

function formatTimestamp(isoString: string, range: HistoryRange): string {
  const d = new Date(isoString)
  if (range === '24h') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatTooltipTimestamp(isoString: string, range: HistoryRange): string {
  const d = new Date(isoString)
  if (range === '24h') return formatTimestamp(isoString, range)
  return `${formatTimestamp(isoString, range)} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

export function ActivityTrendModule({
  size = 'medium',
  isWall = false,
}: {
  size?: DashboardModuleSize
  isWall?: boolean
}) {
  void size
  const [range, setRange] = React.useState<HistoryRange>('24h')

  const historyQuery = useQuery({
    queryKey: queryKeys.history(range),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/stats/history', {
          params: { query: { range } },
          signal,
        }),
      ),
    refetchInterval: 5 * 60_000,
  })

  const points = React.useMemo(() => {
    if (!historyQuery.data?.points) return []
    return historyQuery.data.points.map((p) => ({
      at: p.at,
      online: p.online,
      sessions: p.sessions,
      approved: p.approved,
    }))
  }, [historyQuery.data])

  const latest = points.length > 0 ? points[points.length - 1] : undefined
  const rangeLabels: Record<HistoryRange, string> = { '24h': '24h', '7d': '7d', '30d': '30d' }
  const extent = (key: 'online' | 'sessions') => {
    const values = points.map((point) => point[key])
    return { min: Math.min(...values), max: Math.max(...values) }
  }
  const onlineExtent = points.length > 0 ? extent('online') : undefined
  const sessionsExtent = points.length > 0 ? extent('sessions') : undefined

  return (
    <ModuleCard
      title="Activity trend"
      icon={<TrendingUpIcon className="size-4" />}
      actions={
        <div className="flex items-center gap-1 bg-muted p-0.5 rounded-md">
          {(['24h', '7d', '30d'] as HistoryRange[]).map((r) => (
            <Button
              key={r}
              type="button"
              variant={range === r ? 'default' : 'ghost'}
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setRange(r)}
            >
              {r}
            </Button>
          ))}
        </div>
      }
      contentClassName="flex flex-col h-full"
    >
      {historyQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : historyQuery.isLoadingError ? (
        <ModuleErrorState error={historyQuery.error} retry={() => void historyQuery.refetch()} />
      ) : points.length === 0 ? (
        <ModuleEmptyState message="No history data recorded" />
      ) : (
        <div
          className={cn(
            'flex-1 w-full pt-1 flex flex-col min-h-0',
            isWall ? 'min-h-[120px]' : 'min-h-[160px]',
          )}
        >
          {isWall && (
            <div
              data-slot="wall-trend-legend"
              className="flex items-center gap-4 px-3 py-1 text-sm font-medium text-foreground shrink-0"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="size-2.5 rounded-full bg-[var(--chart-1)] shrink-0"
                  aria-hidden="true"
                />
                <span>Online {latest?.online ?? 0}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className="size-2.5 rounded-full bg-[var(--chart-2)] shrink-0"
                  aria-hidden="true"
                />
                <span>Sessions {latest?.sessions ?? 0}</span>
              </div>
            </div>
          )}
          <div
            role="img"
            aria-label={
              onlineExtent && sessionsExtent && latest
                ? `Activity trend, ${rangeLabels[range]}: online devices ${onlineExtent.min} to ${onlineExtent.max}, now ${latest.online}; sessions ${sessionsExtent.min} to ${sessionsExtent.max}, now ${latest.sessions}`
                : undefined
            }
            className="flex-1 w-full min-h-0"
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={points}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                aria-hidden="true"
                tabIndex={-1}
              >
                <defs>
                  <linearGradient id="trendOnlineGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="trendSessionsGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-2)" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="var(--chart-2)" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.2} />
                <XAxis
                  dataKey="at"
                  tickFormatter={(value: string) => formatTimestamp(value, range)}
                  tickLine={false}
                  axisLine={false}
                  interval={isWall ? Math.max(0, Math.ceil(points.length / 8) - 1) : undefined}
                  tick={{ fontSize: isWall ? 14 : 12, fill: 'var(--muted-foreground)' }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: isWall ? 14 : 12, fill: 'var(--muted-foreground)' }}
                  allowDecimals={false}
                />
                <Tooltip
                  labelFormatter={(label) => formatTooltipTimestamp(String(label), range)}
                  contentStyle={{
                    backgroundColor: 'var(--card)',
                    borderColor: 'var(--border)',
                    borderRadius: '6px',
                    fontSize: '12px',
                    color: 'var(--foreground)',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="online"
                  name="Online devices"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#trendOnlineGrad)"
                />
                <Area
                  type="monotone"
                  dataKey="sessions"
                  name="Active sessions"
                  stroke="var(--chart-2)"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#trendSessionsGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </ModuleCard>
  )
}
