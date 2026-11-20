import * as React from 'react'
import { BarChart3Icon } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { components } from '@/api/schema'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDuration } from '@/lib/ticker'

export type SessionStats = components['schemas']['SessionStats']

export interface SessionsStatsCardProps {
  stats?: SessionStats
  isLoading: boolean
  range: '7d' | '30d'
  onRangeChange: (range: '7d' | '30d') => void
  onSelectDevice?: (deviceId: string) => void
}

export function SessionsStatsCard({
  stats,
  isLoading,
  range,
  onRangeChange,
  onSelectDevice,
}: SessionsStatsCardProps) {
  const perDay = React.useMemo(() => {
    if (!stats?.per_day) return []
    return stats.per_day.map((d) => ({
      day: d.day.slice(5), // MM-DD
      fullDate: d.day,
      count: d.count,
    }))
  }, [stats])

  const topDevices = stats?.top_devices ?? []

  return (
    <Card data-slot="sessions-stats-card" className="border-border bg-card">
      <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3">
        <div className="flex items-center gap-2">
          <BarChart3Icon className="size-4 text-primary-text" />
          <CardTitle className="text-sm font-semibold text-foreground">
            Session activity & stats
          </CardTitle>
        </div>
        <div className="flex items-center gap-1 bg-muted/60 p-0.5 rounded-md">
          <Button
            type="button"
            variant={range === '7d' ? 'default' : 'ghost'}
            size="sm"
            className="h-6 px-2 text-xs font-medium"
            onClick={() => onRangeChange('7d')}
          >
            7 days
          </Button>
          <Button
            type="button"
            variant={range === '30d' ? 'default' : 'ghost'}
            size="sm"
            className="h-6 px-2 text-xs font-medium"
            onClick={() => onRangeChange('30d')}
          >
            30 days
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 space-y-2">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-44 w-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-44 w-full" />
            </div>
          </div>
        ) : !stats || stats.per_day.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            No session statistics available for this period.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
            {/* Left 2 cols: Average KPI + Daily Bar chart */}
            <div className="md:col-span-2 flex flex-col gap-3 min-w-0">
              <div className="flex items-baseline justify-between border-b border-border/40 pb-2">
                <span className="text-xs font-medium text-muted-foreground">
                  Average session duration
                </span>
                <span className="text-lg font-bold tabular-nums text-foreground">
                  {formatDuration(stats.average_seconds)}
                </span>
              </div>

              <div className="h-40 w-full min-w-0" data-slot="sessions-chart-container">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={perDay} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
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
                    <Bar
                      dataKey="count"
                      name="Sessions"
                      fill="var(--chart-1)"
                      radius={[3, 3, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Right col: Top 5 Devices */}
            <div className="flex flex-col gap-2 h-full">
              <span className="text-xs font-semibold text-foreground">Top devices by duration</span>
              {topDevices.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">No device activity recorded.</p>
              ) : (
                <div className="flex flex-col divide-y divide-border/40">
                  {topDevices.map((d) => (
                    <div
                      key={d.device_id}
                      className="flex items-center justify-between py-1.5 text-xs group"
                    >
                      <button
                        type="button"
                        onClick={() => onSelectDevice?.(d.device_id)}
                        className="truncate max-w-[140px] font-medium text-foreground text-left hover:text-primary-text hover:underline cursor-pointer"
                        title={d.device_name}
                      >
                        {d.device_name}
                      </button>
                      <span className="text-muted-foreground tabular-nums text-right shrink-0">
                        {d.count} ({formatDuration(d.total_seconds)})
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
