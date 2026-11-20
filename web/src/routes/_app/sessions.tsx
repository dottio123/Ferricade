import * as React from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { api, unwrap } from '@/api/client'
import { EmptyState } from '@/components/brand/empty-state'
import { ErrorState } from '@/components/brand/error-state'
import { SessionsFilterBar, type SessionsFilters } from '@/components/sessions/sessions-filter-bar'
import { SessionsStatsCard } from '@/components/sessions/sessions-stats-card'
import { SessionsTable } from '@/components/sessions/sessions-table'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'
import { queryKeys, type SessionListParams } from '@/lib/queryKeys'
import { deviceName } from '@/lib/device'

export interface SessionsSearchState extends Omit<SessionsFilters, 'active'> {
  active?: boolean
  stats_range?: '7d' | '30d'
}

function validateSessionsSearch(search: Record<string, unknown>): SessionsSearchState {
  const result: SessionsSearchState = {}
  if (typeof search.device_id === 'string' && search.device_id) {
    result.device_id = search.device_id
  }
  if (search.active === true || search.active === 'true') {
    result.active = true
  } else if (search.active === false || search.active === 'false') {
    result.active = false
  }
  if (search.attempts === true || search.attempts === 'true') {
    result.attempts = true
  }
  if (
    search.range === '24h' ||
    search.range === '7d' ||
    search.range === '30d' ||
    search.range === 'all' ||
    search.range === 'custom'
  ) {
    result.range = search.range
  }
  if (typeof search.since === 'string' && search.since) {
    result.since = search.since
  }
  if (typeof search.until === 'string' && search.until) {
    result.until = search.until
  }
  if (typeof search.startDate === 'string' && search.startDate) {
    result.startDate = search.startDate
  }
  if (typeof search.endDate === 'string' && search.endDate) {
    result.endDate = search.endDate
  }
  if (search.stats_range === '7d' || search.stats_range === '30d') {
    result.stats_range = search.stats_range
  }
  return result
}

export const Route = createFileRoute('/_app/sessions')({
  validateSearch: validateSessionsSearch,
  component: SessionsPage,
})

function SessionsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const detectedTz = React.useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
      return 'UTC'
    }
  }, [])

  // Filter params passed to the API
  const queryFilters = React.useMemo(() => {
    const params: SessionListParams = {}
    if (search.device_id) params.device_id = search.device_id
    if (search.active !== undefined) {
      params.active = search.active ? 'true' : 'false'
    }
    // Attempts toggle: OFF by default, sending authenticated='true'.
    // When toggled on, omit authenticated so authed_at null sessions show up too.
    if (!search.attempts) {
      params.authenticated = 'true'
    }
    if (search.since) params.since = search.since
    if (search.until) params.until = search.until
    return params
  }, [search.device_id, search.active, search.attempts, search.since, search.until])

  // Infinite query for sessions
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: queryKeys.sessions.infinite(queryFilters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      unwrap(
        api.GET('/admin/api/v1/sessions', {
          params: {
            query: {
              ...queryFilters,
              limit: 50,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.next_cursor || undefined,
  })

  // Session stats query
  const statsRange = search.stats_range || '7d'
  const statsQuery = useQuery({
    queryKey: queryKeys.sessionStats({ range: statsRange, tz: detectedTz }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/sessions/stats', {
          params: { query: { range: statsRange, tz: detectedTz } },
          signal,
        }),
      ),
  })

  // Selected device query for friendly name display in filter
  const deviceQuery = useQuery({
    queryKey: queryKeys.device(search.device_id),
    queryFn: ({ signal }) =>
      search.device_id
        ? unwrap(
            api.GET('/admin/api/v1/devices/{id}', {
              params: { path: { id: search.device_id } },
              signal,
            }),
          )
        : null,
    enabled: Boolean(search.device_id),
    staleTime: 60_000,
  })

  const selectedDeviceName = deviceQuery.data ? deviceName(deviceQuery.data) : undefined

  // Combine pages
  const allSessions = React.useMemo(() => {
    if (!data?.pages) return []
    return data.pages.flatMap((page) => page.items)
  }, [data])

  const handleFilterChange = (newFilters: Partial<SessionsFilters>) => {
    void navigate({
      search: (prev: SessionsSearchState) => ({
        ...prev,
        ...newFilters,
      }),
    })
  }

  const handleResetFilters = () => {
    void navigate({
      search: () => ({}),
    })
  }

  const handleStatsRangeChange = (range: '7d' | '30d') => {
    void navigate({
      search: (prev: SessionsSearchState) => ({
        ...prev,
        stats_range: range,
      }),
    })
  }

  const handleSelectDevice = (deviceId: string) => {
    void navigate({
      search: (prev: SessionsSearchState) => ({
        ...prev,
        device_id: deviceId,
      }),
    })
  }

  return (
    <div className="flex flex-col gap-6 w-full p-0 sm:p-6" data-slot="sessions-page">
      <PageHeader
        title="Sessions"
        description="Live connection monitoring, audit history, and duration analytics across your fleet."
      />

      {/* Analytics & Stats Chart */}
      <SessionsStatsCard
        stats={statsQuery.data}
        isLoading={statsQuery.isLoading}
        range={statsRange}
        onRangeChange={handleStatsRangeChange}
        onSelectDevice={handleSelectDevice}
      />

      {/* Filter Bar */}
      <SessionsFilterBar
        filters={search}
        onChange={handleFilterChange}
        onReset={handleResetFilters}
        selectedDeviceName={selectedDeviceName}
      />

      {/* Table Content */}
      {isLoading ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : isError ? (
        <ErrorState error={error} retry={() => void refetch()} />
      ) : allSessions.length === 0 ? (
        <EmptyState
          title="No sessions found"
          description={
            search.device_id || search.active || search.since
              ? 'No sessions match your active filter criteria. Try resetting your filters.'
              : 'No remote sessions have been recorded yet.'
          }
          action={
            (search.device_id || search.active || search.since || search.attempts) && (
              <Button variant="outline" size="sm" onClick={handleResetFilters}>
                Reset filters
              </Button>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <SessionsTable sessions={allSessions} />

          {hasNextPage && (
            <div className="flex justify-center py-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Loading more…' : 'Load more sessions'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
