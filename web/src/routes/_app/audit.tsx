import * as React from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { api, unwrap } from '@/api/client'
import { useRole } from '@/auth/role'
import { EmptyState } from '@/components/brand/empty-state'
import { ErrorState } from '@/components/brand/error-state'
import { AuditFilterBar, type AuditFilters } from '@/components/audit/audit-filter-bar'
import { AuditTimeline } from '@/components/audit/audit-timeline'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'
import { useAuditActorResolver } from '@/features/audit/actor'
import { queryKeys, type AuditListParams } from '@/lib/queryKeys'

function validateAuditSearch(search: Record<string, unknown>): AuditFilters {
  const result: AuditFilters = {}
  if (typeof search.action === 'string' && search.action) {
    result.action = search.action
  }
  if (typeof search.actor === 'string' && search.actor) {
    result.actor = search.actor
  }
  if (typeof search.target === 'string' && search.target) {
    result.target = search.target
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
  return result
}

export const Route = createFileRoute('/_app/audit')({
  validateSearch: validateAuditSearch,
  component: AuditPage,
})

function AuditPage() {
  const routeSearch = Route.useSearch()
  // A User's log holds their own actions only: no actor filter.
  const isUser = useRole() === 'user'
  const search = React.useMemo<AuditFilters>(
    () => (isUser ? { ...routeSearch, actor: undefined } : routeSearch),
    [isUser, routeSearch],
  )
  const navigate = Route.useNavigate()

  const { resolveActor, isOwner, users, currentUserId } = useAuditActorResolver()

  // Filters passed to the API
  const queryFilters = React.useMemo(() => {
    const params: AuditListParams = {}
    if (search.action) params.action = search.action
    if (search.actor) params.actor = search.actor
    if (search.target) params.target = search.target
    if (search.since) params.since = search.since
    if (search.until) params.until = search.until
    return params
  }, [search.action, search.actor, search.target, search.since, search.until])

  // Infinite query for audit log
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
    queryKey: queryKeys.audit.infinite(queryFilters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      unwrap(
        api.GET('/admin/api/v1/audit', {
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

  // Combine pages
  const allEvents = React.useMemo(() => {
    if (!data?.pages) return []
    return data.pages.flatMap((page) => page.items)
  }, [data])

  const handleFilterChange = (newFilters: Partial<AuditFilters>) => {
    void navigate({
      search: (prev: AuditFilters) => ({
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

  return (
    <div className="flex flex-col gap-6 w-full p-0 sm:p-6" data-slot="audit-page">
      <PageHeader
        title="Audit Log"
        description={
          isUser
            ? 'Your actions'
            : 'Append-only record of all administrative changes, authentications, and device actions.'
        }
      />

      {/* Filter Bar */}
      <AuditFilterBar
        filters={search}
        onChange={handleFilterChange}
        onReset={handleResetFilters}
        isOwner={isOwner}
        users={users}
        currentUserId={currentUserId}
        hideActor={isUser}
      />

      {/* Content */}
      {isLoading ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : isError ? (
        <ErrorState error={error} retry={() => void refetch()} />
      ) : allEvents.length === 0 ? (
        <EmptyState
          title="No audit events found"
          description={
            search.action || search.actor || search.target || search.since
              ? 'No audit log entries match your active filter criteria. Try resetting your filters.'
              : 'No audit log entries recorded yet.'
          }
          action={
            (search.action || search.actor || search.target || search.since) && (
              <Button variant="outline" size="sm" onClick={handleResetFilters}>
                Reset filters
              </Button>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <AuditTimeline
            events={allEvents}
            resolveActor={resolveActor}
            isOwner={isOwner}
            users={users}
          />

          {hasNextPage && (
            <div className="flex justify-center py-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Loading more…' : 'Load more events'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
