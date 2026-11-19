import * as React from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { api, unwrap } from '@/api/client'
import { useRole } from '@/auth/role'
import { EmptyState } from '@/components/brand/empty-state'
import { ErrorState } from '@/components/brand/error-state'
import { BulkActionBar } from '@/components/devices/bulk-action-bar'
import { DevicesFilterBar, type DevicesFilters } from '@/components/devices/devices-filter-bar'
import { DevicesTable, type Device } from '@/components/devices/devices-table'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { queryKeys } from '@/lib/queryKeys'
import { groupsQueryOptions } from '@/lib/queries'
import { useAllTags } from '@/lib/tags'
import { flattenGroups } from '@/components/groups/group-utils'
import { useApproveDevices } from '@/components/devices/use-approve-devices'

// ?device= (the device panel) belongs to the app shell (src/routes/_app.tsx).
type DevicesSearch = DevicesFilters
type DeviceSort = NonNullable<DevicesFilters['sort']>
const DEVICE_SORTS: readonly DeviceSort[] = ['name', 'status', 'state', 'os', 'group']

function validateDevicesSearch(search: Record<string, unknown>): DevicesSearch {
  const result: DevicesSearch = {}
  if (typeof search.q === 'string' && search.q) result.q = search.q
  if (
    search.state === 'pending' ||
    search.state === 'approved' ||
    search.state === 'rejected' ||
    search.state === 'archived'
  ) {
    result.state = search.state
  }
  if (search.online === true || search.online === 'true') result.online = true
  if (search.online === false || search.online === 'false') result.online = false
  if (typeof search.group === 'string' && search.group) result.group = search.group
  if (
    typeof result.group === 'string' &&
    result.group !== 'ungrouped' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.group) &&
    (search.subgroups === true || search.subgroups === 'true')
  )
    result.subgroups = true
  if (typeof search.tag === 'string' && search.tag) result.tag = search.tag
  if (typeof search.os === 'string' && search.os) result.os = search.os
  if (typeof search.sort === 'string' && DEVICE_SORTS.includes(search.sort as DeviceSort)) {
    result.sort = search.sort as DeviceSort
    if (search.order === 'asc' || search.order === 'desc') result.order = search.order
    else result.order = 'asc'
  }
  return result
}

export const Route = createFileRoute('/_app/devices/')({
  validateSearch: validateDevicesSearch,
  component: DevicesPage,
})

function DevicesPage() {
  const routeSearch = validateDevicesSearch(Route.useSearch())
  // A User sees approved devices only: no state filter, no selection, no bulk actions.
  const isUser = useRole() === 'user'
  const search = React.useMemo<DevicesSearch>(
    () => (isUser ? { ...routeSearch, state: undefined } : routeSearch),
    [isUser, routeSearch],
  )
  const navigate = Route.useNavigate()
  const queryClient = useQueryClient()

  // Selection state
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())

  // Clear selection whenever filters or search change
  const filterKey = `${search.q ?? ''}|${search.state ?? ''}|${String(search.online)}|${search.group ?? ''}|${String(search.subgroups)}|${search.tag ?? ''}|${search.os ?? ''}`
  const [prevFilterKey, setPrevFilterKey] = React.useState(filterKey)
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey)
    setSelectedIds(new Set())
  }

  const hasFilters = Boolean(
    search.q || search.online !== undefined || search.group || search.tag || search.os,
  )

  // Filters for the query
  const queryFilters = React.useMemo(
    () => ({
      q: search.q,
      state: search.state,
      online: search.online,
      group: search.group === 'ungrouped' ? undefined : search.group,
      subgroups: search.subgroups,
      ungrouped: search.group === 'ungrouped' ? true : undefined,
      tag: search.tag,
      os: search.os,
      sort: search.sort,
      order: search.order,
    }),
    [
      search.q,
      search.state,
      search.online,
      search.group,
      search.subgroups,
      search.tag,
      search.os,
      search.sort,
      search.order,
    ],
  )

  // Infinite query for devices
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
    queryKey: queryKeys.devices.infinite(queryFilters),
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      unwrap(
        api.GET('/admin/api/v1/devices', {
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

  // Auto-follow next_cursor when online=true returns an empty items page
  React.useEffect(() => {
    if (!data?.pages || !hasNextPage || isFetchingNextPage) return
    const lastPage = data.pages[data.pages.length - 1]
    if (lastPage && lastPage.items.length === 0 && lastPage.next_cursor) {
      void fetchNextPage()
    }
  }, [data, hasNextPage, isFetchingNextPage, fetchNextPage])

  // Supporting queries: groups and tags
  const groupsQuery = useQuery(groupsQueryOptions)

  const tagsQuery = useAllTags()

  const flatGroups = React.useMemo(
    () => flattenGroups(groupsQuery.data?.items ?? []).map(({ group }) => group),
    [groupsQuery.data],
  )

  const groupsMap = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const g of flatGroups) {
      map.set(g.id, g.name)
    }
    return map
  }, [flatGroups])

  const loadedDevices = React.useMemo<Device[]>(
    () => data?.pages.flatMap((p) => p.items) ?? [],
    [data],
  )

  const selectedDevices = React.useMemo(
    () => loadedDevices.filter((d) => selectedIds.has(d.id)),
    [loadedDevices, selectedIds],
  )

  // Quick actions mutations
  const approveDevices = useApproveDevices()
  const approveMutation = useMutation({
    meta: { errorTitle: 'Could not approve the device' },
    mutationFn: async (device: Device) => {
      const result = await approveDevices.approve([device])
      if (result.failed.length) throw result.failed[0]!.error
      return result.success[0]!.result
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
    },
  })

  const rejectMutation = useMutation({
    meta: { errorTitle: 'Could not reject the device' },
    mutationFn: (id: string) =>
      unwrap(api.POST('/admin/api/v1/devices/{id}/reject', { params: { path: { id } } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
    },
  })

  // Handlers for filter bar
  const handleFilterChange = (patch: Partial<DevicesFilters>) => {
    void navigate({
      search: (prev) => {
        const next = { ...validateDevicesSearch(prev), device: prev.device, ...patch }
        // Clean up undefined keys
        for (const k of Object.keys(next) as (keyof DevicesSearch)[]) {
          if (next[k] === undefined) delete next[k]
        }
        return next
      },
      replace: true,
    })
  }

  const handleClearFilters = () => {
    void navigate({
      search: (prev) => {
        const valid = validateDevicesSearch(prev)
        return { device: prev.device, sort: valid.sort, order: valid.order }
      },
      replace: true,
    })
  }

  // Selection handlers
  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleToggleSelectAll = () => {
    if (loadedDevices.every((d) => selectedIds.has(d.id))) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(loadedDevices.map((d) => d.id)))
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Devices"
        description="View, filter, and manage stock RustDesk client devices connected to your infrastructure."
      />

      {/* Filter Bar */}
      <DevicesFilterBar
        filters={search}
        hideState={isUser}
        onFilterChange={handleFilterChange}
        onClearFilters={handleClearFilters}
        onSortChange={(sort, order) => handleFilterChange({ sort, order })}
        groups={groupsQuery.data?.items ?? []}
        tags={tagsQuery.data ?? []}
      />

      {/* Table / Error / Empty States */}
      {isError ? (
        <ErrorState error={error} retry={() => void refetch()} />
      ) : loadedDevices.length === 0 && !isLoading ? (
        isUser && !hasFilters ? (
          <EmptyState
            title="No devices"
            description="No devices are assigned to you yet. Ask an owner to assign devices or groups."
          />
        ) : (
          <EmptyState
            title="No devices match these filters"
            description="Try adjusting or clearing your search and filter criteria."
            action={
              <Button type="button" variant="outline" size="sm" onClick={handleClearFilters}>
                Clear filters
              </Button>
            }
          />
        )
      ) : (
        <div className="flex flex-col gap-4">
          {!isUser && (
            <BulkActionBar
              selectedDevices={selectedDevices}
              tags={tagsQuery.data ?? []}
              onClearSelection={() => setSelectedIds(new Set())}
            />
          )}

          <DevicesTable
            devices={loadedDevices}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            selectable={!isUser}
            onApproveQuick={isUser ? undefined : (d) => approveMutation.mutate(d)}
            onRejectQuick={isUser ? undefined : (d) => rejectMutation.mutate(d.id)}
            groupsMap={groupsMap}
            sort={search.sort}
            order={search.order}
            onSortChange={(sort, order) => handleFilterChange({ sort, order })}
            isLoading={isLoading}
          />

          {hasNextPage && (
            <div className="flex justify-center py-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Loading more…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
