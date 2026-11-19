import * as React from 'react'
import { FilterXIcon, SearchIcon, SlidersHorizontalIcon, XIcon } from 'lucide-react'
import type { components } from '@/api/schema'
import { GroupPicker } from '@/components/groups/group-tree-picker'
import { findGroupById, type Group } from '@/components/groups/group-utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { toCss } from '@/lib/tagColor'
import { cn } from '@/lib/utils'

export interface DevicesFilters {
  q?: string
  state?: 'pending' | 'approved' | 'rejected' | 'archived'
  online?: boolean
  group?: string
  subgroups?: boolean
  tag?: string
  os?: string
  sort?: 'name' | 'status' | 'state' | 'os' | 'group'
  order?: 'asc' | 'desc'
}

export interface DevicesFilterBarProps {
  filters: DevicesFilters
  onFilterChange: (patch: Partial<DevicesFilters>) => void
  onClearFilters: () => void
  onSortChange: (sort: DevicesFilters['sort'], order: DevicesFilters['order']) => void
  /** The group tree, as GET /groups returns it. */
  groups: Group[]
  tags: components['schemas']['Tag'][]
  /** No state filter: a User sees approved devices only. */
  hideState?: boolean
  className?: string
}

export function DevicesFilterBar({
  filters,
  onFilterChange,
  onClearFilters,
  onSortChange,
  groups,
  tags,
  hideState = false,
  className,
}: DevicesFilterBarProps) {
  const [searchInput, setSearchInput] = React.useState(filters.q ?? '')
  const [prevPropQ, setPrevPropQ] = React.useState(filters.q)

  if (filters.q !== prevPropQ) {
    setPrevPropQ(filters.q)
    setSearchInput(filters.q ?? '')
  }

  // Debounce search query by 250ms
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = filters.q ?? ''
      const next = searchInput.trim()
      if (next !== current) {
        onFilterChange({ q: next || undefined })
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [searchInput, filters.q, onFilterChange])

  const [osInput, setOsInput] = React.useState(filters.os ?? '')
  const [prevPropOs, setPrevPropOs] = React.useState(filters.os)

  if (filters.os !== prevPropOs) {
    setPrevPropOs(filters.os)
    setOsInput(filters.os ?? '')
  }

  // Debounce OS query by 250ms
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = filters.os ?? ''
      const next = osInput.trim()
      if (next !== current) {
        onFilterChange({ os: next || undefined })
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [osInput, filters.os, onFilterChange])

  const state = hideState ? undefined : filters.state
  const selectedGroup =
    filters.group && filters.group !== 'ungrouped' ? findGroupById(groups, filters.group) : null

  const hasActiveFilters = Boolean(
    filters.q ||
    state ||
    filters.online !== undefined ||
    filters.group ||
    filters.tag ||
    filters.os,
  )

  const activeNonSearchFilters = [
    state,
    filters.online !== undefined,
    filters.group,
    filters.tag,
    filters.os,
  ].filter(Boolean).length

  const stateSelect = (
    <Select
      value={filters.state ?? 'all'}
      onValueChange={(val) =>
        onFilterChange({
          state:
            val === 'all' ? undefined : (val as 'pending' | 'approved' | 'rejected' | 'archived'),
        })
      }
    >
      <SelectTrigger className="text-xs w-full" aria-label="Filter by state">
        <SelectValue placeholder="State: All" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">State: All</SelectItem>
        <SelectItem value="approved">Approved</SelectItem>
        <SelectItem value="pending">Pending</SelectItem>
        <SelectItem value="rejected">Rejected</SelectItem>
        <SelectItem value="archived">Archived</SelectItem>
      </SelectContent>
    </Select>
  )

  const onlineSelect = (
    <Select
      value={filters.online === undefined ? 'all' : filters.online ? 'online' : 'offline'}
      onValueChange={(val) =>
        onFilterChange({
          online: val === 'all' ? undefined : val === 'online',
        })
      }
    >
      <SelectTrigger className="text-xs w-full" aria-label="Filter by online status">
        <SelectValue placeholder="Status: All" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Status: All</SelectItem>
        <SelectItem value="online">Online</SelectItem>
        <SelectItem value="offline">Offline</SelectItem>
      </SelectContent>
    </Select>
  )

  const osField = (
    <Input
      type="search"
      placeholder="Filter OS…"
      value={osInput}
      onChange={(e) => setOsInput(e.target.value)}
      className="text-xs w-full h-[var(--control-height,2.25rem)]"
    />
  )

  const groupSelect = (
    <GroupPicker
      groups={groups}
      value={filters.group ?? null}
      onChange={(id) =>
        onFilterChange({
          group: id ?? undefined,
          subgroups: id && id !== 'ungrouped' ? filters.subgroups : undefined,
        })
      }
      noneLabel="All groups"
      ungroupedOption="Ungrouped"
      ungroupedValue="ungrouped"
      ariaLabel="Filter by group"
      hint={
        filters.group === 'ungrouped'
          ? 'Shows devices that are in no group.'
          : filters.subgroups
            ? undefined
            : 'Shows devices in this group only, not its subgroups.'
      }
    />
  )
  const groupControl = (
    <div className="flex flex-col gap-2">
      {groupSelect}
      {selectedGroup && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={filters.subgroups ?? false}
            onChange={(event) => onFilterChange({ subgroups: event.target.checked || undefined })}
            className="size-4 accent-primary"
          />
          Include subgroups
        </label>
      )}
    </div>
  )

  const tagSelect = (
    <Select
      value={filters.tag ?? 'all'}
      onValueChange={(val) => onFilterChange({ tag: val === 'all' ? undefined : val })}
    >
      <SelectTrigger className="text-xs w-full" aria-label="Filter by tag">
        <SelectValue placeholder="Tag: All" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Tag: All</SelectItem>
        {tags.map((t) => (
          <SelectItem key={t.id} value={t.id}>
            <div className="flex items-center gap-1.5">
              <span
                className="size-2 rounded-full shrink-0"
                style={{ backgroundColor: toCss(t.color) }}
              />
              <span>{t.name}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const sortSelect = (
    <Select
      value={filters.sort ?? 'default'}
      onValueChange={(value) =>
        onSortChange(
          value === 'default' ? undefined : (value as NonNullable<DevicesFilters['sort']>),
          value === 'default' ? undefined : 'asc',
        )
      }
    >
      <SelectTrigger className="text-xs w-full" aria-label="Sort devices">
        <SelectValue placeholder="Sort: Default" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">Sort: Default</SelectItem>
        <SelectItem value="status">Sort: Status</SelectItem>
        <SelectItem value="name">Sort: Device</SelectItem>
        <SelectItem value="state">Sort: State</SelectItem>
        <SelectItem value="os">Sort: OS / Version</SelectItem>
        <SelectItem value="group">Sort: Group</SelectItem>
      </SelectContent>
    </Select>
  )

  return (
    <div data-slot="devices-filter-bar" className={cn('flex flex-col gap-3', className)}>
      {/* Search Input & Mobile Filters Button */}
      <div className="flex items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            type="search"
            placeholder="Search ID, alias, host, user…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-8 text-xs h-[var(--control-height,2.25rem)]"
          />
        </div>

        {/* Mobile Filters Sheet Trigger (below md) */}
        <div className="md:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-[var(--control-height,2.25rem)] gap-1.5 text-xs font-medium"
                aria-label={`Open filters${activeNonSearchFilters > 0 ? ` (${activeNonSearchFilters} active)` : ''}`}
              >
                <SlidersHorizontalIcon className="size-3.5" />
                <span>Filters</span>
                {activeNonSearchFilters > 0 && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-2xs font-mono ml-0.5">
                    {activeNonSearchFilters}
                  </Badge>
                )}
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-80 flex flex-col gap-4 p-5 overflow-y-auto">
              <SheetHeader>
                <SheetTitle className="text-base font-semibold">Filter devices</SheetTitle>
              </SheetHeader>
              <div className="flex flex-col gap-3 pt-2">
                {!hideState && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">State</span>
                    {stateSelect}
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Status</span>
                  {onlineSelect}
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Operating System
                  </span>
                  {osField}
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Group</span>
                  {groupControl}
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Tag</span>
                  {tagSelect}
                </div>
                {hasActiveFilters && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onClearFilters}
                    className="mt-2 text-xs text-muted-foreground hover:text-foreground justify-start px-2"
                  >
                    <FilterXIcon className="size-3.5 mr-1.5" />
                    Clear all filters
                  </Button>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      <div className="flex items-center gap-2 md:hidden">
        <div className="min-w-0 flex-1">{sortSelect}</div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-[var(--control-height,2.25rem)] shrink-0 text-xs"
          aria-label={`Order ${filters.order === 'desc' ? 'descending' : 'ascending'}`}
          aria-pressed={filters.order !== 'desc'}
          disabled={!filters.sort}
          onClick={() => onSortChange(filters.sort, filters.order === 'desc' ? 'asc' : 'desc')}
        >
          {filters.order === 'desc' ? 'Descending' : 'Ascending'}
        </Button>
      </div>

      {/* Desktop Filters: hidden below md, inline from md up */}
      <div className="hidden md:flex md:flex-wrap md:items-start md:gap-3">
        {!hideState && <div className="w-[130px]">{stateSelect}</div>}
        <div className="w-[120px]">{onlineSelect}</div>
        <div className="w-[120px]">{osField}</div>
        <div className="w-[140px]">{groupControl}</div>
        <div className="w-[140px]">{tagSelect}</div>
        {hasActiveFilters && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClearFilters}
            className="h-[var(--control-height,2.25rem)] gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <FilterXIcon className="size-3.5" />
            <span>Clear filters</span>
          </Button>
        )}
      </div>
      {filters.group === 'ungrouped' && (
        <Badge variant="secondary" className="w-fit gap-1 pl-2 pr-1">
          Ungrouped
          <button
            type="button"
            aria-label="Remove Ungrouped filter"
            onClick={() => onFilterChange({ group: undefined })}
            className="rounded-sm p-0.5 hover:bg-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-3" aria-hidden="true" />
          </button>
        </Badge>
      )}
      {selectedGroup && (
        <Badge variant="secondary" className="w-fit gap-1 pl-2 pr-1">
          {selectedGroup.name}
          {filters.subgroups ? ' and subgroups' : ''}
          <button
            type="button"
            aria-label={`Remove ${selectedGroup.name} filter`}
            onClick={() => onFilterChange({ group: undefined, subgroups: undefined })}
            className="rounded-sm p-0.5 hover:bg-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-3" aria-hidden="true" />
          </button>
        </Badge>
      )}
    </div>
  )
}
