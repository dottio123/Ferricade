import * as React from 'react'
import { DeviceLink } from '@/components/devices/device-link'
import { deviceName, deviceStatus, STATUS_LABEL } from '@/lib/device'
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, StarIcon } from 'lucide-react'
import type { components } from '@/api/schema'
import { useRawPreferences, useUpdatePreferences } from '@/features/dashboard/use-preferences'
import { MonoId } from '@/components/brand/mono-id'
import { RelativeTime } from '@/components/brand/relative-time'
import { StatusDot } from '@/components/brand/status-dot'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ApproveRejectActions } from './approve-reject-actions'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { pageBackgroundColor, textColorFor, toCss } from '@/lib/tagColor'
import { cn } from '@/lib/utils'

export type Device = components['schemas']['Device']

export interface DevicesTableProps {
  devices: Device[]
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onToggleSelectAll: () => void
  /** False hides the selection checkboxes (a User has no bulk actions). Default true. */
  selectable?: boolean
  onApproveQuick?: (device: Device) => void
  onRejectQuick?: (device: Device) => void
  groupsMap: Map<string, string>
  sort?: 'name' | 'status' | 'state' | 'os' | 'group'
  order?: 'asc' | 'desc'
  onSortChange?: (
    sort: 'name' | 'status' | 'state' | 'os' | 'group' | undefined,
    order: 'asc' | 'desc' | undefined,
  ) => void
  isLoading?: boolean
  className?: string
}

function useIsMobile() {
  return React.useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {}
      }
      const mql = window.matchMedia('(max-width: 767px)')
      mql.addEventListener('change', onStoreChange)
      return () => mql.removeEventListener('change', onStoreChange)
    },
    () => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false
      }
      return window.matchMedia('(max-width: 767px)').matches
    },
    () => false,
  )
}

export function DevicesTable({
  devices,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  selectable = true,
  onApproveQuick,
  onRejectQuick,
  groupsMap,
  sort,
  order,
  onSortChange,
  isLoading = false,
  className,
}: DevicesTableProps) {
  const isMobile = useIsMobile()
  const preferencesQuery = useRawPreferences()
  const { togglePin } = useUpdatePreferences()
  const pinnedIds = React.useMemo(
    () => new Set(preferencesQuery.data?.pinned_device_ids ?? []),
    [preferencesQuery.data?.pinned_device_ids],
  )

  const allSelected = devices.length > 0 && devices.every((d) => selectedIds.has(d.id))
  const someSelected =
    devices.length > 0 && !allSelected && devices.some((d) => selectedIds.has(d.id))

  const sortableHeader = (
    label: string,
    key: 'name' | 'status' | 'state' | 'os' | 'group',
    className?: string,
  ) => {
    const active = sort === key
    const direction = active ? (order ?? 'asc') : undefined
    return (
      <TableHead
        className={className}
        aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button
          type="button"
          aria-label={`Sort by ${label}`}
          onClick={() => {
            if (!onSortChange) return
            if (!active) onSortChange(key, 'asc')
            else if (direction === 'asc') onSortChange(key, 'desc')
            else onSortChange(undefined, undefined)
          }}
          className="group inline-flex min-h-8 items-center gap-1 rounded-sm text-left font-medium hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span>{label}</span>
          <span className="inline-flex size-4 shrink-0 items-center justify-center">
            {direction === 'asc' ? (
              <ArrowUpIcon className="size-3.5" aria-hidden="true" />
            ) : direction === 'desc' ? (
              <ArrowDownIcon className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronsUpDownIcon
                className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                aria-hidden="true"
              />
            )}
          </span>
        </button>
      </TableHead>
    )
  }

  return (
    <div data-slot="devices-table" className={cn('w-full', className)}>
      {isMobile ? (
        <div data-slot="devices-mobile-cards" className="flex flex-col gap-2.5">
          {isLoading && devices.length === 0
            ? Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={`skeleton-card-${i}`} className="h-24 w-full rounded-md" />
              ))
            : devices.map((device) => {
                const isSelected = selectedIds.has(device.id)
                const isPinned = pinnedIds.has(device.id)
                const name = deviceName(device)

                return (
                  <div
                    key={device.id}
                    data-slot="device-card"
                    data-device-id={device.id}
                    data-state={isSelected ? 'selected' : undefined}
                    className="device-fade-enter rounded-md border border-border bg-card p-3 shadow-xs flex flex-col gap-2 transition-colors data-[state=selected]:bg-muted/60 data-[state=selected]:border-primary/40"
                  >
                    {/* Top row: Checkbox + Pin + Name/Host + Actions */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        {selectable && (
                          <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              aria-label={`Select device ${name}`}
                              checked={isSelected}
                              onChange={() => onToggleSelect(device.id)}
                              className="size-4 rounded border-input text-primary-text focus:ring-ring cursor-pointer"
                            />
                          </div>
                        )}
                        <button
                          type="button"
                          aria-pressed={isPinned}
                          aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${name}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            togglePin(device.id)
                          }}
                          className={cn(
                            'rounded-xs p-0.5 text-muted-foreground hover:text-status-pending focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring cursor-pointer shrink-0 transition-opacity',
                            isPinned
                              ? 'text-status-pending fill-status-pending opacity-100'
                              : 'opacity-70 focus-visible:opacity-100',
                          )}
                        >
                          <StarIcon
                            className={cn(
                              'size-4',
                              isPinned
                                ? 'text-status-pending fill-status-pending'
                                : 'text-muted-foreground hover:text-status-pending',
                            )}
                          />
                        </button>
                        <div className="flex flex-col min-w-0">
                          <DeviceLink
                            deviceId={device.id}
                            className="font-medium text-sm text-foreground hover:underline truncate"
                          >
                            {name}
                          </DeviceLink>
                          {device.alias && device.hostname && (
                            <span className="text-xs text-muted-foreground truncate">
                              {device.hostname}
                            </span>
                          )}
                        </div>
                      </div>

                      <div
                        data-slot="device-card-actions"
                        className="flex items-center gap-1.5 shrink-0 ml-auto"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {device.state === 'pending' ? (
                          <ApproveRejectActions
                            onApprove={() => onApproveQuick?.(device)}
                            onReject={() => onRejectQuick?.(device)}
                            approveAriaLabel={`Approve ${name}`}
                            rejectAriaLabel={`Reject ${name}`}
                            size="sm"
                          />
                        ) : (
                          <DeviceLink
                            deviceId={device.id}
                            className="text-xs font-medium text-muted-foreground hover:text-foreground inline-flex items-center px-2 py-1 rounded-sm border border-border/60 hover:bg-muted transition-colors"
                          >
                            Details →
                          </DeviceLink>
                        )}
                      </div>
                    </div>

                    <span className="text-xs text-muted-foreground break-all">
                      User: {device.username || '\u2014'}
                    </span>

                    {/* Meta row: Status dot + words, OS, Last seen */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground pt-1 border-t border-border/40">
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <StatusDot status={deviceStatus(device)} size="sm" />
                        <span className="capitalize">{STATUS_LABEL[deviceStatus(device)]}</span>
                      </div>
                      {device.os && (
                        <>
                          <span className="text-border">•</span>
                          <span>
                            {device.os}
                            {device.client_version ? ` v${device.client_version}` : ''}
                          </span>
                        </>
                      )}
                      <span className="text-border">•</span>
                      <span>
                        <RelativeTime date={device.last_seen_at} />
                      </span>
                      {device.state !== 'approved' && (
                        <Badge
                          variant={
                            device.state === 'pending'
                              ? 'pending'
                              : device.state === 'rejected'
                                ? 'alert'
                                : 'secondary'
                          }
                          className="ml-auto text-2xs px-1.5 py-0"
                        >
                          {device.state}
                        </Badge>
                      )}
                    </div>
                  </div>
                )
              })}
        </div>
      ) : (
        <div
          data-slot="devices-desktop-table"
          className="rounded-md border border-border bg-card overflow-x-auto"
        >
          <Table>
            <TableHeader>
              <TableRow>
                {selectable && (
                  <TableHead className="w-10 px-3">
                    <input
                      type="checkbox"
                      aria-label="Select all loaded devices"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected
                      }}
                      onChange={onToggleSelectAll}
                      className="size-4 rounded border-input text-primary-text focus:ring-ring cursor-pointer align-middle"
                    />
                  </TableHead>
                )}
                {sortableHeader('Status', 'status')}
                {sortableHeader('Device', 'name')}
                <TableHead className="hidden sm:table-cell">RustDesk ID</TableHead>
                {sortableHeader('State', 'state', 'hidden md:table-cell')}
                {sortableHeader('OS / Version', 'os', 'hidden lg:table-cell')}
                {sortableHeader('Group', 'group', 'hidden md:table-cell')}
                <TableHead className="hidden lg:table-cell">Tags</TableHead>
                <TableHead className="hidden sm:table-cell">Last Seen</TableHead>
                <TableHead className="text-right w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {isLoading && devices.length === 0
                ? // Skeleton Rows
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={`skeleton-${i}`}>
                      {selectable && (
                        <TableCell className="px-3">
                          <Skeleton className="size-4 rounded" />
                        </TableCell>
                      )}
                      <TableCell className="text-center">
                        <Skeleton className="size-2 rounded-full mx-auto" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-32" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Skeleton className="h-4 w-16" />
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <Skeleton className="h-4 w-20" />
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Skeleton className="h-4 w-16" />
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <Skeleton className="h-4 w-20" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-16" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-6 w-16 ml-auto" />
                      </TableCell>
                    </TableRow>
                  ))
                : devices.map((device) => {
                    const isSelected = selectedIds.has(device.id)
                    const isPinned = pinnedIds.has(device.id)
                    const name = deviceName(device)
                    const groupName = device.group_id
                      ? (groupsMap.get(device.group_id) ?? '—')
                      : 'No group'

                    return (
                      <tr
                        key={device.id}
                        data-device-id={device.id}
                        data-state={isSelected ? 'selected' : undefined}
                        className="device-fade-enter group/row border-b border-border transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted/60 cursor-pointer"
                      >
                        {/* Checkbox */}
                        {selectable && (
                          <TableCell className="w-10 px-3" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              aria-label={`Select device ${name}`}
                              checked={isSelected}
                              onChange={() => onToggleSelect(device.id)}
                              className="size-4 rounded border-input text-primary-text focus:ring-ring cursor-pointer align-middle"
                            />
                          </TableCell>
                        )}

                        {/* Status Dot */}
                        <TableCell className="w-12 text-center">
                          <div className="flex justify-center items-center">
                            {/* The dot is decorative (aria-hidden): the status in words for screen readers. */}
                            <span className="sr-only">{STATUS_LABEL[deviceStatus(device)]}</span>
                            <StatusDot status={deviceStatus(device)} size="md" />
                          </div>
                        </TableCell>

                        {/* Device Alias / Hostname (Keyboard Accessible Link) */}
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              aria-pressed={isPinned}
                              aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${name}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                togglePin(device.id)
                              }}
                              className={cn(
                                'rounded-xs p-1 text-muted-foreground hover:text-status-pending focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring cursor-pointer shrink-0 transition-opacity',
                                isPinned
                                  ? 'text-status-pending fill-status-pending opacity-100'
                                  : 'opacity-70 group-hover/row:opacity-100 focus-visible:opacity-100',
                              )}
                            >
                              <StarIcon
                                className={cn(
                                  'size-4',
                                  isPinned
                                    ? 'text-status-pending fill-status-pending'
                                    : 'text-muted-foreground hover:text-status-pending',
                                )}
                              />
                            </button>
                            <div className="flex flex-col min-w-0">
                              <DeviceLink
                                deviceId={device.id}
                                className="font-medium text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-xs"
                              >
                                {name}
                              </DeviceLink>
                              {device.alias && device.hostname && (
                                <span className="text-xs text-muted-foreground">
                                  {device.hostname}
                                </span>
                              )}
                              <span className="min-w-32 max-w-48 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                User: {device.username || '\u2014'}
                              </span>
                            </div>
                          </div>
                        </TableCell>

                        {/* RustDesk ID */}
                        <TableCell
                          className="hidden sm:table-cell"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MonoId idText={device.rustdesk_id} />
                        </TableCell>

                        {/* Device State */}
                        <TableCell className="hidden md:table-cell">
                          <Badge
                            variant={
                              device.state === 'approved'
                                ? 'outline'
                                : device.state === 'pending'
                                  ? 'pending'
                                  : device.state === 'rejected'
                                    ? 'alert'
                                    : 'secondary'
                            }
                          >
                            {device.state}
                          </Badge>
                        </TableCell>

                        {/* OS & Version */}
                        <TableCell className="hidden lg:table-cell">
                          <div className="flex flex-col text-xs">
                            <span>{device.os}</span>
                            {device.client_version && (
                              <span className="text-xs text-muted-foreground font-mono">
                                v{device.client_version}
                              </span>
                            )}
                          </div>
                        </TableCell>

                        {/* Group */}
                        <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                          {groupName}
                        </TableCell>

                        {/* Tags */}
                        <TableCell
                          className="hidden lg:table-cell"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex flex-wrap gap-1 max-w-[180px]">
                            {device.tags.length === 0 ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : (
                              device.tags.map((t) => (
                                <span
                                  data-slot="tag-label"
                                  key={t.id}
                                  className="inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium"
                                  style={{
                                    backgroundColor: toCss(t.color),
                                    color: textColorFor(t.color, pageBackgroundColor()),
                                  }}
                                >
                                  {t.name}
                                </span>
                              ))
                            )}
                          </div>
                        </TableCell>

                        {/* Last Seen */}
                        <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                          <RelativeTime date={device.last_seen_at} />
                        </TableCell>

                        {/* Quick Actions */}
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          {device.state === 'pending' ? (
                            <div className="flex justify-end">
                              <ApproveRejectActions
                                onApprove={() => onApproveQuick?.(device)}
                                onReject={() => onRejectQuick?.(device)}
                                approveAriaLabel={`Approve ${name}`}
                                rejectAriaLabel={`Reject ${name}`}
                                size="sm"
                              />
                            </div>
                          ) : (
                            <DeviceLink
                              deviceId={device.id}
                              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center justify-end"
                            >
                              Details
                            </DeviceLink>
                          )}
                        </TableCell>
                      </tr>
                    )
                  })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
