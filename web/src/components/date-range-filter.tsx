import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { dateRangeToIso } from '@/lib/ticker'

interface DateRangeFilters {
  range?: '24h' | '7d' | '30d' | 'all' | 'custom'
  since?: string
  until?: string
  startDate?: string
  endDate?: string
}

export function DateRangeFilter({
  filters,
  onChange,
  part,
}: {
  filters: DateRangeFilters
  onChange: (filters: Partial<DateRangeFilters>) => void
  part: 'presets' | 'custom'
}) {
  const currentRange = filters.range || 'all'
  const isCustom = currentRange === 'custom'
  const handleRangeChange = (newRange: '24h' | '7d' | '30d' | 'all' | 'custom') => {
    if (newRange === 'all') {
      onChange({ range: undefined, since: undefined, until: undefined })
    } else if (newRange === '24h') {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      onChange({ range: '24h', since, until: undefined })
    } else if (newRange === '7d') {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      onChange({ range: '7d', since, until: undefined })
    } else if (newRange === '30d') {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      onChange({ range: '30d', since, until: undefined })
    } else {
      onChange({ range: 'custom' })
    }
  }

  const handleCustomDateChange = (start: string, end: string) => {
    if (start && end) {
      try {
        const { since, until } = dateRangeToIso(start, end)
        onChange({ range: 'custom', since, until, startDate: start, endDate: end })
      } catch {
        // Invalid date input, ignore
      }
    } else {
      onChange({ startDate: start, endDate: end })
    }
  }

  if (part === 'presets')
    return (
      <div className="flex items-center justify-between sm:justify-start gap-1 bg-muted/60 p-0.5 rounded-md w-full sm:w-auto">
        <Button
          type="button"
          variant={currentRange === 'all' ? 'default' : 'ghost'}
          size="sm"
          className="min-w-0 flex-1 sm:flex-initial h-7 px-1.5 sm:px-2 text-xs font-medium text-center"
          onClick={() => handleRangeChange('all')}
        >
          All time
        </Button>
        <Button
          type="button"
          variant={currentRange === '24h' ? 'default' : 'ghost'}
          size="sm"
          className="min-w-0 flex-1 sm:flex-initial h-7 px-1.5 sm:px-2 text-xs font-medium text-center"
          onClick={() => handleRangeChange('24h')}
        >
          24h
        </Button>
        <Button
          type="button"
          variant={currentRange === '7d' ? 'default' : 'ghost'}
          size="sm"
          className="min-w-0 flex-1 sm:flex-initial h-7 px-1.5 sm:px-2 text-xs font-medium text-center"
          onClick={() => handleRangeChange('7d')}
        >
          7d
        </Button>
        <Button
          type="button"
          variant={currentRange === '30d' ? 'default' : 'ghost'}
          size="sm"
          className="min-w-0 flex-1 sm:flex-initial h-7 px-1.5 sm:px-2 text-xs font-medium text-center"
          onClick={() => handleRangeChange('30d')}
        >
          30d
        </Button>
        <Button
          type="button"
          variant={currentRange === 'custom' ? 'default' : 'ghost'}
          size="sm"
          className="min-w-0 flex-1 sm:flex-initial h-7 px-1.5 sm:px-2 text-xs font-medium text-center"
          onClick={() => handleRangeChange('custom')}
        >
          Custom
        </Button>
      </div>
    )
  return (
    <>
      {isCustom && (
        <div className="flex items-center gap-2 pt-2 border-t border-border/40 text-xs">
          <span className="text-muted-foreground">From:</span>
          <Input
            type="date"
            className="h-7 w-36 text-xs"
            value={filters.startDate ?? ''}
            onChange={(e) => handleCustomDateChange(e.target.value, filters.endDate ?? '')}
          />
          <span className="text-muted-foreground">To:</span>
          <Input
            type="date"
            className="h-7 w-36 text-xs"
            value={filters.endDate ?? ''}
            onChange={(e) => handleCustomDateChange(filters.startDate ?? '', e.target.value)}
          />
        </div>
      )}
    </>
  )
}
