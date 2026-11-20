import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ActivityIcon, AlertCircleIcon, LaptopIcon, RadioIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { useRole } from '@/auth/role'
import type { components } from '@/api/schema'
import { Skeleton } from '@/components/ui/skeleton'
import { queryKeys } from '@/lib/queryKeys'
import { summaryQueryOptions } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { DashboardModuleSize } from '../preferences'
import { ModuleCard, ModuleErrorState } from './module-card'

type Summary = components['schemas']['FleetSummary']
type HistoryPoint = components['schemas']['FleetHistory']['points'][number]
type AttentionKind = Summary['attention'][number]['kind']

// Fleet pulse answers "is everything all right?" with four numbers. Each has
// a line of context instead of a graph (the user asked for no sparklines):
// what share is online, how long devices have waited, today's session peak,
// and what else needs attention. The change versus 24 h ago comes from the
// oldest point of GET /stats/history?range=24h.

/** "+2 vs 24 h ago", "-1 vs 24 h ago", "no change"; null without history. */
export function formatChange(current: number | undefined, past: number | undefined) {
  if (current === undefined || past === undefined) return null
  const diff = current - past
  if (diff > 0) return `+${diff} vs 24 h ago`
  if (diff < 0) return `${diff} vs 24 h ago`
  return 'no change'
}

/** How many attention items there are of each kind. */
export function countAttention(attention: Summary['attention']) {
  const counts: Record<AttentionKind, number> = {
    uuid_mismatch: 0,
    access_window_unconfirmed: 0,
    group_conflict: 0,
    pending_long: 0,
    offline_long: 0,
    outdated_client: 0,
  }
  for (const item of attention) counts[item.kind] += 1
  return counts
}

/** The other issues besides open alerts, in words; null when there are none. */
export function otherIssues(counts: Record<AttentionKind, number>) {
  const parts: string[] = []
  if (counts.offline_long > 0) parts.push(`${counts.offline_long} offline for long`)
  if (counts.outdated_client > 0)
    parts.push(
      `${counts.outdated_client} outdated client${counts.outdated_client === 1 ? '' : 's'}`,
    )
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The open alerts line under the number (uuid mismatches and unconfirmed access windows). */
export function formatOpenAlerts(counts: Record<AttentionKind, number>) {
  const parts: string[] = [
    `${counts.uuid_mismatch} uuid mismatch${counts.uuid_mismatch === 1 ? '' : 'es'}`,
  ]
  if (counts.access_window_unconfirmed > 0) {
    parts.push(
      `${counts.access_window_unconfirmed} access window${counts.access_window_unconfirmed === 1 ? '' : 's'} not confirmed`,
    )
  }
  return parts.join(' · ')
}

export function FleetPulseModule({
  size = 'medium',
  isWall = false,
}: {
  size?: DashboardModuleSize
  isWall?: boolean
}) {
  const summaryQuery = useQuery(summaryQueryOptions)
  // GET /stats/history is not a User's: no change-versus-yesterday lines for them.
  const role = useRole()
  const canSeeHistory = role !== 'user'
  const historyQuery = useQuery({
    enabled: canSeeHistory,
    queryKey: queryKeys.history('24h'),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/stats/history', { params: { query: { range: '24h' } }, signal }),
      ),
    // No live event refreshes history (see src/README.md).
    refetchInterval: 5 * 60_000,
  })

  const summary = summaryQuery.data
  const points = historyQuery.data?.points ?? []
  const dayAgo: HistoryPoint | undefined = points[0]
  const sessionPeak = points.length > 0 ? Math.max(...points.map((p) => p.sessions)) : undefined

  const icon = <ActivityIcon className="size-4" />
  if (summaryQuery.isLoadingError) {
    return (
      <ModuleCard title="Fleet pulse" icon={icon}>
        <ModuleErrorState error={summaryQuery.error} retry={() => void summaryQuery.refetch()} />
      </ModuleCard>
    )
  }

  const compact = size === 'small'
  const counts = summary ? countAttention(summary.attention) : undefined
  const onlineShare =
    summary && summary.devices.approved > 0
      ? Math.round((summary.devices.online / summary.devices.approved) * 100)
      : 0

  return (
    <ModuleCard title="Fleet pulse" icon={icon} data-wall={isWall ? 'true' : undefined}>
      <div
        className={cn(
          'grid h-full',
          compact
            ? role === 'user'
              ? 'grid-cols-3 gap-2 items-center'
              : 'grid-cols-4 gap-2 items-center'
            : role === 'user'
              ? 'grid-cols-2 lg:grid-cols-3 lg:divide-x lg:divide-border/40 gap-x-4 gap-y-3'
              : 'grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-border/40 gap-x-4 gap-y-3',
        )}
      >
        <Tile
          label="Online"
          icon={<LaptopIcon className={cn(compact ? 'size-3' : 'size-3.5')} />}
          loading={!summary}
          value={summary?.devices.online}
          suffix={compact ? undefined : summary ? `of ${summary.devices.approved}` : undefined}
          change={compact ? null : formatChange(summary?.devices.online, dayAgo?.online)}
          compact={compact}
        >
          {summary && (
            <div className="flex flex-col gap-1 leading-none">
              <div
                role="meter"
                aria-label="Approved devices online"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={onlineShare}
                className="h-1 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-status-online"
                  style={{ width: `${onlineShare}%` }}
                />
              </div>
              <span className="truncate leading-tight">
                {onlineShare}% online · {summary.devices.approved - summary.devices.online} offline
              </span>
            </div>
          )}
        </Tile>

        {role !== 'user' && (
          <Tile
            label="Pending"
            icon={<RadioIcon className={cn(compact ? 'size-3' : 'size-3.5')} />}
            loading={!summary}
            value={summary?.devices.pending}
            tone={summary && summary.devices.pending > 0 ? 'pending' : undefined}
            change={compact ? null : formatChange(summary?.devices.pending, dayAgo?.pending)}
            compact={compact}
          >
            {summary &&
              counts &&
              (summary.devices.pending === 0 ? (
                <span>Nothing waiting for approval</span>
              ) : counts.pending_long > 0 ? (
                <span className="text-status-pending">
                  {counts.pending_long} waiting more than 24 h
                </span>
              ) : (
                <span>All arrived in the last 24 h</span>
              ))}
          </Tile>
        )}

        <Tile
          label="Live sessions"
          icon={<ActivityIcon className={cn(compact ? 'size-3' : 'size-3.5')} />}
          loading={!summary}
          value={summary?.sessions.active}
          change={compact ? null : formatChange(summary?.sessions.active, dayAgo?.sessions)}
          compact={compact}
        >
          {sessionPeak !== undefined && <span>Peak in the last 24 h: {sessionPeak}</span>}
        </Tile>

        <Tile
          label="Open alerts"
          icon={<AlertCircleIcon className={cn(compact ? 'size-3' : 'size-3.5')} />}
          loading={!summary}
          value={summary?.alerts.open}
          tone={summary && summary.alerts.open > 0 ? 'alert' : undefined}
          href={summary && summary.alerts.open > 0 ? '/devices' : undefined}
          compact={compact}
        >
          {summary &&
            counts &&
            (summary.alerts.open > 0 ? (
              <span>
                {formatOpenAlerts(counts)}
                {otherIssues(counts) ? ` · ${otherIssues(counts)}` : ''}
              </span>
            ) : (
              <span>{otherIssues(counts) ?? 'All clear'}</span>
            ))}
        </Tile>
      </div>
    </ModuleCard>
  )
}

interface TileProps {
  label: string
  icon: React.ReactNode
  loading: boolean
  value: number | undefined
  suffix?: string
  tone?: 'pending' | 'alert'
  change?: string | null
  /** Where the number links to, when there is something to act on. */
  href?: '/devices'
  compact: boolean
  /** The line of context under the number (hidden at small size). */
  children?: React.ReactNode
}

function Tile({
  label,
  icon,
  loading,
  value,
  suffix,
  tone,
  change,
  href,
  compact,
  children,
}: TileProps) {
  const number = (
    <span
      data-slot="pulse-number"
      className={cn(
        'font-semibold tabular-nums leading-none',
        compact ? 'text-lg md:text-xl' : 'text-3xl',
        tone === 'pending' && 'text-status-pending',
        tone === 'alert' && 'text-status-alert',
        !tone && 'text-foreground',
        href && 'group-hover:underline',
      )}
    >
      {value}
    </span>
  )
  return (
    <div
      data-slot="fleet-pulse-tile"
      className={cn(
        'flex min-w-0 flex-col',
        compact ? 'gap-1 px-1' : 'gap-1 md:px-3 md:first:pl-0',
      )}
    >
      <span
        data-slot="pulse-label"
        className={cn(
          'flex items-center font-medium text-muted-foreground truncate leading-tight',
          compact ? 'gap-1 text-xs' : 'gap-1.5 text-xs',
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {loading ? (
        <Skeleton className={compact ? 'h-5 w-10' : 'h-8 w-20'} />
      ) : (
        <div className="flex items-baseline gap-1.5 leading-none">
          {href ? (
            <Link
              to={href}
              className="group rounded-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {number}
            </Link>
          ) : (
            number
          )}
          {suffix && (
            <span className={cn('text-muted-foreground truncate', compact ? 'text-xs' : 'text-sm')}>
              {suffix}
            </span>
          )}
          {change && (
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">{change}</span>
          )}
        </div>
      )}
      {!compact && !loading && children && (
        <div
          data-slot="pulse-context"
          className="mt-auto text-xs leading-none text-muted-foreground"
        >
          {children}
        </div>
      )}
    </div>
  )
}
