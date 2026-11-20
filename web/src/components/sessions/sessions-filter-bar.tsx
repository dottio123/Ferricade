import { FilterXIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DateRangeFilter } from '@/components/date-range-filter'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

export interface SessionsFilters {
  device_id?: string
  active?: boolean
  attempts?: boolean
  range?: '24h' | '7d' | '30d' | 'all' | 'custom'
  since?: string
  until?: string
  startDate?: string
  endDate?: string
}

export interface SessionsFilterBarProps {
  filters: SessionsFilters
  onChange: (filters: Partial<SessionsFilters>) => void
  onReset: () => void
  deviceCount?: number
  selectedDeviceName?: string
}

export function SessionsFilterBar({
  filters,
  onChange,
  onReset,
  selectedDeviceName,
}: SessionsFilterBarProps) {
  const hasActiveFilters = Boolean(
    filters.device_id ||
    filters.active ||
    filters.attempts ||
    filters.range ||
    filters.since ||
    filters.until,
  )

  return (
    <div
      data-slot="sessions-filter-bar"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 shadow-xs"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        {/* Left side: Status select, Time range, Device chip */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
          {/* Status filter: All / Active / Ended */}
          <div className="w-full sm:w-[130px]">
            <Select
              value={filters.active === true ? 'true' : filters.active === false ? 'false' : 'all'}
              onValueChange={(val) => {
                onChange({
                  active: val === 'all' ? undefined : val === 'true',
                })
              }}
            >
              <SelectTrigger className="h-8 text-xs w-full" aria-label="Filter by session status">
                <SelectValue placeholder="All sessions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sessions</SelectItem>
                <SelectItem value="true">Active only</SelectItem>
                <SelectItem value="false">Ended only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Time range preset buttons */}
          <DateRangeFilter filters={filters} onChange={onChange} part="presets" />

          {/* Active device filter badge */}
          {filters.device_id && (
            <Badge
              variant="secondary"
              className="h-7 px-2 text-xs gap-1.5 bg-primary/10 text-primary-text border border-primary/20 w-fit"
            >
              <span>Device: {selectedDeviceName || filters.device_id.slice(0, 8)}</span>
              <button
                type="button"
                onClick={() => onChange({ device_id: undefined })}
                className="hover:text-destructive cursor-pointer ml-1"
                aria-label="Clear device filter"
              >
                ×
              </button>
            </Badge>
          )}
        </div>

        {/* Right side: Attempts toggle and Clear filters */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 sm:ml-auto w-full sm:w-auto pt-1 sm:pt-0 border-t border-border/40 sm:border-0">
          {hasActiveFilters && (
            <div className="flex justify-end w-full sm:w-auto order-2 sm:order-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1 px-2"
                onClick={onReset}
              >
                <FilterXIcon className="size-3" />
                Reset
              </Button>
            </div>
          )}

          {/* Include attempts switch */}
          <div className="flex items-center justify-between sm:justify-start gap-2 w-full sm:w-auto order-1 sm:order-2">
            <label
              htmlFor="include-attempts-switch"
              className="text-xs font-medium text-muted-foreground select-none cursor-pointer order-1 sm:order-2"
            >
              Include attempts
            </label>
            <Switch
              id="include-attempts-switch"
              checked={!!filters.attempts}
              onCheckedChange={(checked) => onChange({ attempts: checked || undefined })}
              className="order-2 sm:order-1"
            />
          </div>
        </div>
      </div>

      {/* Custom date range picker row */}
      <DateRangeFilter filters={filters} onChange={onChange} part="custom" />
    </div>
  )
}
