import * as React from 'react'
import { DeviceLink } from '@/components/devices/device-link'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangleIcon, ChevronRightIcon, Clock3Icon, LayoutGridIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { useMe } from '@/auth/session'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { queryKeys } from '@/lib/queryKeys'
import { groupsQueryOptions, summaryQueryOptions } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { DashboardModuleSize } from '../preferences'
import { ModuleCard, ModuleEmptyState, ModuleErrorState } from './module-card'
import {
  buildFleetTree,
  filterWallRows,
  formatBarAccessibleText,
  formatCompactHeaderBadgeText,
  formatHeaderBadgeText,
  shouldCollapseToBar,
  type FleetGroupNode,
  type FleetMapDevice,
} from './fleet-overview-tree'

export type DeviceStatus = 'alert' | 'pending' | 'online' | 'offline'

const statusSquareClasses: Record<FleetMapDevice['status'], string> = {
  online: 'bg-status-online text-white',
  offline: 'bg-status-offline text-white',
  alert: 'bg-status-alert text-white',
}

export function statusSquareGlyph(status: string): React.ReactNode {
  if (status === 'alert') return <AlertTriangleIcon className="size-3" aria-hidden="true" />
  if (status === 'pending') return <Clock3Icon className="size-3" aria-hidden="true" />
  return null
}

const STORAGE_PREFIX = 'ferricade:fleet-overview:expanded:'

function getStorageKey(userId?: string): string {
  return `${STORAGE_PREFIX}${userId ?? 'anonymous'}`
}

function loadExpanded(userId?: string): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    // eslint-disable-next-line no-restricted-globals
    const raw = localStorage.getItem(getStorageKey(userId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed))
      return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    // Ignore localStorage errors
  }
  return new Set()
}

function saveExpanded(expanded: Set<string>, userId?: string): void {
  if (typeof window === 'undefined') return
  try {
    // eslint-disable-next-line no-restricted-globals
    localStorage.setItem(getStorageKey(userId), JSON.stringify([...expanded]))
  } catch {
    // Ignore localStorage errors
  }
}

export function FleetOverviewModule({
  size = 'medium',
  isWall = false,
}: {
  size?: DashboardModuleSize
  isWall?: boolean
}) {
  const meQuery = useMe()
  const userId = meQuery.data?.user?.id

  const fleetMapQuery = useQuery({
    queryKey: queryKeys.fleetMap(),
    queryFn: ({ signal }) => unwrap(api.GET('/admin/api/v1/stats/fleet-map', { signal })),
  })

  const groupsQuery = useQuery(groupsQueryOptions)

  const summaryQuery = useQuery({
    ...summaryQueryOptions,
    enabled: Boolean(fleetMapQuery.data?.truncated),
  })

  const [lastUserId, setLastUserId] = React.useState(userId)
  const [expanded, setExpanded] = React.useState<Set<string>>(() => loadExpanded(userId))

  if (userId !== lastUserId) {
    setLastUserId(userId)
    setExpanded(loadExpanded(userId))
  }

  const toggleExpand = React.useCallback(
    (groupId: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(groupId)) {
          next.delete(groupId)
        } else {
          next.add(groupId)
        }
        saveExpanded(next, userId)
        return next
      })
    },
    [userId],
  )

  const [containerWidth, setContainerWidth] = React.useState<number>(0)
  const [containerHeight, setContainerHeight] = React.useState<number>(240)
  const observerRef = React.useRef<ResizeObserver | null>(null)

  const containerCallbackRef = React.useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    if (node) {
      setContainerWidth(node.clientWidth)
      setContainerHeight(node.clientHeight || 240)

      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver((entries) => {
          for (const entry of entries) {
            if (entry.contentBoxSize) {
              setContainerWidth(entry.contentRect.width)
              setContainerHeight(entry.contentRect.height)
            } else {
              setContainerWidth(node.clientWidth)
              setContainerHeight(node.clientHeight || 240)
            }
          }
        })
        ro.observe(node)
        observerRef.current = ro
      }
    }
  }, [])

  const groups = React.useMemo(() => groupsQuery.data?.items ?? [], [groupsQuery.data?.items])
  const devices = React.useMemo(
    () => fleetMapQuery.data?.devices ?? [],
    [fleetMapQuery.data?.devices],
  )
  const isTruncated = Boolean(fleetMapQuery.data?.truncated)

  const { topLevelRows, totalApproved, totalOffline, totalAlert } = React.useMemo(
    () => buildFleetTree(groups, devices),
    [groups, devices],
  )

  const badgeText = React.useMemo(
    () =>
      formatHeaderBadgeText({
        total: totalApproved,
        offline: totalOffline,
        alert: totalAlert,
      }),
    [totalApproved, totalOffline, totalAlert],
  )
  const compactBadgeText = React.useMemo(
    () =>
      formatCompactHeaderBadgeText({
        total: totalApproved,
        offline: totalOffline,
        alert: totalAlert,
      }),
    [totalApproved, totalOffline, totalAlert],
  )

  const maxLines = size === 'large' ? 4 : 2

  // Wall rows calculation
  const wallResult = React.useMemo(() => {
    if (!isWall) return null
    // Wall card body fit: approx 46px per row; floor at 3 rows
    const availableHeight = containerHeight
    const maxWallRows = Math.max(3, Math.floor((availableHeight - 16) / 46))
    return filterWallRows(topLevelRows, maxWallRows)
  }, [isWall, topLevelRows, containerHeight])

  const isError = fleetMapQuery.isError || groupsQuery.isError
  const error = fleetMapQuery.error ?? groupsQuery.error
  const isLoading = fleetMapQuery.isLoading || groupsQuery.isLoading

  const refetch = React.useCallback(() => {
    void fleetMapQuery.refetch()
    void groupsQuery.refetch()
  }, [fleetMapQuery, groupsQuery])

  const renderNodesOrBar = (row: FleetGroupNode, isRowExpanded: boolean) => {
    const rowDevices = isRowExpanded ? row.directDevices : row.allDevices

    if (row.total === 0) {
      return (
        <span className="text-xs text-muted-foreground italic shrink-0">
          {row.depth === 0 ? 'no devices' : '—'}
        </span>
      )
    }

    // In an expanded parent with 0 direct devices (devices sit in subgroups):
    if (isRowExpanded && row.directDevices.length === 0) {
      return null
    }

    // Available width for nodes in this row
    // Left column takes ~180px plus indentation on desktop; on phone (below sm) row is 2 lines
    const indentWidth = row.depth * 16
    const leftWidth =
      containerWidth > 0 && containerWidth < 640 && !isWall ? 24 + indentWidth : 190 + indentWidth
    const availableNodesWidth = Math.max(0, containerWidth - leftWidth)

    const needsBar =
      size === 'small' ||
      isTruncated ||
      shouldCollapseToBar({
        deviceCount: rowDevices.length,
        availableWidth: availableNodesWidth,
        maxLines,
      })

    const accessibleText = formatBarAccessibleText({
      alert: row.alertCount,
      offline: row.offlineCount,
      online: row.onlineClean,
    })

    if (needsBar) {
      if (size === 'small') {
        return (
          <div
            className="h-1.5 w-full max-w-48 sm:w-20 rounded-full bg-muted/40 overflow-hidden flex shrink-0"
            role="img"
            aria-label={accessibleText}
          >
            {row.alertCount > 0 && (
              <div
                className="bg-status-alert h-full"
                style={{ width: `${(row.alertCount / row.total) * 100}%` }}
              />
            )}
            {row.offlineCount > 0 && (
              <div
                className="bg-status-offline h-full"
                style={{ width: `${(row.offlineCount / row.total) * 100}%` }}
              />
            )}
            {row.onlineClean > 0 && (
              <div
                className="bg-status-online h-full"
                style={{ width: `${(row.onlineClean / row.total) * 100}%` }}
              />
            )}
          </div>
        )
      }

      return (
        <div
          className="flex items-center gap-1.5 sm:gap-2 flex-1 min-w-0"
          role="img"
          aria-label={accessibleText}
          title={accessibleText}
        >
          <div className="h-2 flex-1 min-w-8 sm:min-w-16 max-w-xs rounded-full bg-muted/40 overflow-hidden flex shrink-0">
            {row.alertCount > 0 && (
              <div
                className="bg-status-alert h-full"
                style={{ width: `${(row.alertCount / row.total) * 100}%` }}
              />
            )}
            {row.offlineCount > 0 && (
              <div
                className="bg-status-offline h-full"
                style={{ width: `${(row.offlineCount / row.total) * 100}%` }}
              />
            )}
            {row.onlineClean > 0 && (
              <div
                className="bg-status-online h-full"
                style={{ width: `${(row.onlineClean / row.total) * 100}%` }}
              />
            )}
          </div>

          {/* Desktop full counts */}
          <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono tabular-nums text-muted-foreground shrink-0">
            {row.alertCount > 0 && (
              <span className="text-status-alert font-medium">{row.alertCount} alert</span>
            )}
            {row.offlineCount > 0 && <span>{row.offlineCount} offline</span>}
            <span>{row.onlineClean} online</span>
          </div>

          {/* Phone compact counts: only non-zero problem counts, or online if healthy */}
          <div className="flex sm:hidden items-center gap-1 text-2xs font-mono tabular-nums text-muted-foreground shrink-0 whitespace-nowrap">
            {row.alertCount > 0 && (
              <span className="text-status-alert font-medium">{row.alertCount}⚠</span>
            )}
            {row.offlineCount > 0 && <span>{row.offlineCount} off</span>}
            {row.alertCount === 0 && row.offlineCount === 0 && (
              <span>{row.onlineClean} online</span>
            )}
          </div>
        </div>
      )
    }

    return (
      <div className="flex flex-wrap gap-1.5 items-center flex-1 min-w-0">
        {rowDevices.map((d) => (
          <Tooltip key={d.id}>
            <TooltipTrigger asChild>
              {isWall ? (
                <div
                  aria-label={`${d.name}, ${d.status}`}
                  className={cn(
                    'size-7 rounded-md flex items-center justify-center shrink-0',
                    statusSquareClasses[d.status],
                  )}
                >
                  <span className="sr-only">
                    {d.name}, {d.status}
                  </span>
                  {statusSquareGlyph(d.status)}
                </div>
              ) : (
                <DeviceLink
                  deviceId={d.id}
                  aria-label={`${d.name}, ${d.status}`}
                  className={cn(
                    'size-6 rounded-md flex items-center justify-center transition-all hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden shrink-0',
                    statusSquareClasses[d.status],
                  )}
                >
                  <span className="sr-only">
                    {d.name}, {d.status}
                  </span>
                  {statusSquareGlyph(d.status)}
                </DeviceLink>
              )}
            </TooltipTrigger>
            <TooltipContent>
              <span className="font-medium">{d.name}</span>
              <span className="text-muted-foreground ml-1 capitalize">({d.status})</span>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    )
  }

  const renderGroupRow = (row: FleetGroupNode) => {
    const isRowExpanded = row.id !== null && expanded.has(row.id)
    const hasSubgroups = row.hasSubgroups && !isWall

    return (
      <li key={row.id ?? 'ungrouped'} className="flex flex-col gap-1.5 shrink-0">
        <div
          className={cn(
            isWall
              ? 'flex items-center gap-2.5 min-h-7 justify-start'
              : 'flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2.5 min-h-7 justify-start',
            size === 'small' && !isWall ? 'sm:justify-between' : '',
          )}
          style={{ paddingLeft: `${row.depth * 16}px` }}
        >
          {/* Left group meta (Line 1 below sm) */}
          <div
            data-slot="fleet-group-header"
            className={cn(
              'flex items-center gap-1.5 shrink-0',
              isWall
                ? 'w-48 justify-between'
                : size === 'small'
                  ? 'w-full justify-between sm:w-auto sm:min-w-0 sm:flex-1 sm:justify-start'
                  : 'w-full justify-between sm:w-48',
            )}
          >
            <div className="flex items-center gap-1 min-w-0 flex-1 sm:flex-initial truncate">
              {hasSubgroups ? (
                <button
                  type="button"
                  aria-expanded={isRowExpanded}
                  aria-controls={`group-subgroups-${row.id}`}
                  aria-label={isRowExpanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
                  onClick={() => row.id && toggleExpand(row.id)}
                  className="size-5 rounded flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronRightIcon
                    className={cn(
                      'size-3.5 transition-transform duration-150',
                      isRowExpanded && 'rotate-90',
                    )}
                    aria-hidden="true"
                  />
                </button>
              ) : (
                !isWall && <span className="size-5 shrink-0" aria-hidden="true" />
              )}

              {isWall ? (
                <span title={row.name} className="text-xs font-medium text-foreground truncate">
                  {row.name}
                </span>
              ) : row.id === null ? (
                <Link
                  to="/devices"
                  search={{ group: 'ungrouped' } as unknown as Record<string, unknown>}
                  title={row.name}
                  className="text-xs font-medium text-foreground hover:text-primary hover:underline truncate focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-xs"
                >
                  {row.name}
                </Link>
              ) : (
                <Link
                  to="/devices"
                  search={{ group: row.id, subgroups: true } as unknown as Record<string, unknown>}
                  title={row.name}
                  className="text-xs font-medium text-foreground hover:text-primary hover:underline truncate focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-xs"
                >
                  {row.name}
                </Link>
              )}
            </div>

            <span className="text-xs font-mono tabular-nums text-muted-foreground shrink-0 pr-1">
              <span className="font-semibold text-foreground">{row.online}</span>/{row.total}
            </span>
          </div>

          {/* Right nodes / bar (Line 2 below sm) */}
          {(() => {
            const content = renderNodesOrBar(row, isRowExpanded)
            if (!content) return null
            return (
              <div
                data-slot="fleet-group-content"
                className={cn(
                  'min-w-0 flex-1',
                  !isWall && 'pl-6 sm:pl-0',
                  size === 'small' && !isWall && 'w-full sm:w-auto sm:flex-initial',
                )}
              >
                {content}
              </div>
            )
          })()}
        </div>

        {/* Recursive subgroups */}
        {hasSubgroups && isRowExpanded && (
          <ul id={`group-subgroups-${row.id}`} className="flex flex-col gap-1.5 list-none m-0 p-0">
            {row.children.map((child) => renderGroupRow(child))}
          </ul>
        )}
      </li>
    )
  }

  const desktopBadgeElement = (
    <Badge
      variant="outline"
      className={cn(
        'hidden sm:inline-flex text-xs font-mono px-2 py-0.5 whitespace-nowrap shrink-0',
        isTruncated && 'cursor-help',
      )}
      aria-label={badgeText}
      title={!isTruncated ? badgeText : undefined}
    >
      {badgeText}
    </Badge>
  )

  const mobileBadgeElement = (
    <Badge
      variant="outline"
      className={cn(
        'text-2xs font-mono px-1.5 py-0.5 whitespace-nowrap shrink-0',
        isTruncated && 'cursor-help',
      )}
      aria-label={badgeText}
      title={!isTruncated ? badgeText : undefined}
    >
      {compactBadgeText}
    </Badge>
  )

  return (
    <ModuleCard
      title="Fleet overview"
      contentClassName="min-h-0"
      icon={<LayoutGridIcon className="size-4" />}
      badge={
        totalApproved > 0 ? (
          isTruncated ? (
            <Tooltip>
              <TooltipTrigger asChild>{desktopBadgeElement}</TooltipTrigger>
              <TooltipContent>
                Showing 2000 of {summaryQuery.data?.devices.approved ?? totalApproved} devices
              </TooltipContent>
            </Tooltip>
          ) : (
            desktopBadgeElement
          )
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
    >
      {isError ? (
        <ModuleErrorState error={error} retry={refetch} />
      ) : isLoading ? (
        <div className="flex flex-col gap-3 py-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-5 w-32 shrink-0" />
              <Skeleton className="h-5 w-12 shrink-0" />
              <Skeleton className="h-5 flex-1" />
            </div>
          ))}
        </div>
      ) : totalApproved === 0 ? (
        <ModuleEmptyState message="No approved devices in fleet" />
      ) : isWall ? (
        <div
          ref={containerCallbackRef}
          data-slot="fleet-overview-wall"
          className="flex flex-col gap-2 h-full overflow-hidden"
        >
          <ul className="flex flex-col gap-2 list-none m-0 p-0">
            {wallResult?.visibleRows.map((row) => renderGroupRow(row))}
          </ul>
          {wallResult && wallResult.hiddenHealthyCount > 0 && (
            <div className="text-xs font-medium text-muted-foreground pt-1 pl-1 font-mono">
              +{wallResult.hiddenHealthyCount} healthy groups
            </div>
          )}
        </div>
      ) : (
        <div
          ref={containerCallbackRef}
          data-slot="fleet-overview-body"
          role="region"
          aria-label="Fleet groups"
          tabIndex={0}
          className="flex flex-col gap-2 h-full overflow-y-auto pr-1"
        >
          {totalApproved > 0 && (
            <div className="sm:hidden flex items-center pb-1">
              {isTruncated ? (
                <Tooltip>
                  <TooltipTrigger asChild>{mobileBadgeElement}</TooltipTrigger>
                  <TooltipContent>
                    Showing 2000 of {summaryQuery.data?.devices.approved ?? totalApproved} devices
                  </TooltipContent>
                </Tooltip>
              ) : (
                mobileBadgeElement
              )}
            </div>
          )}
          <ul className="flex flex-col gap-2 list-none m-0 p-0">
            {topLevelRows.map((row) => renderGroupRow(row))}
          </ul>
        </div>
      )}
    </ModuleCard>
  )
}
