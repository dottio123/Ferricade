import * as React from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import type { components } from '@/api/schema'
import { ErrorState } from '@/components/brand/error-state'
import { GroupCheckTree } from '@/components/groups/group-tree-picker'
import type { Group } from '@/components/groups/group-utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import type { User } from '@/features/audit/actor'
import { deviceName } from '@/lib/device'
import { queryKeys } from '@/lib/queryKeys'
import { groupsQueryOptions } from '@/lib/queries'

type Grants = components['schemas']['UserGrants']

/** Every group below a checked group: a group grant covers its subtree. */
export function coveredGroupIds(tree: Group[], checked: ReadonlySet<string>): Set<string> {
  const covered = new Set<string>()
  const visit = (groups: Group[], underChecked: boolean) => {
    for (const group of groups) {
      if (underChecked) covered.add(group.id)
      visit(group.children ?? [], underChecked || checked.has(group.id))
    }
  }
  visit(tree, false)
  return covered
}

/** The PUT body contains only direct grants, never subgroups covered by a checked parent. */
export function grantsBody(
  tree: Group[],
  groupIds: ReadonlySet<string>,
  deviceIds: ReadonlySet<string>,
): Grants {
  const covered = coveredGroupIds(tree, groupIds)
  return { group_ids: [...groupIds].filter((id) => !covered.has(id)), device_ids: [...deviceIds] }
}

function groupNameMap(tree: Group[]): Map<string, string> {
  const names = new Map<string, string>()
  const visit = (list: Group[]) => {
    for (const group of list) {
      names.set(group.id, group.name)
      if (group.children?.length) visit(group.children)
    }
  }
  visit(tree)
  return names
}

function toggled(set: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

const checkboxClass = 'size-4 shrink-0 rounded border-border accent-primary disabled:opacity-60'

function GroupList({
  tree,
  groupIds,
  onChange,
}: {
  tree: Group[]
  groupIds: ReadonlySet<string>
  onChange: (next: Set<string>) => void
}) {
  const covered = coveredGroupIds(tree, groupIds)
  if (tree.length === 0) {
    return <p className="text-xs text-muted-foreground">There are no groups yet.</p>
  }
  return (
    <GroupCheckTree
      groups={tree}
      checkedIds={groupIds}
      coveredIds={covered}
      onToggle={(id, on) => onChange(toggled(groupIds, id, on))}
    />
  )
}

function DeviceList({
  deviceIds,
  groupNames,
  onChange,
}: {
  deviceIds: ReadonlySet<string>
  groupNames: ReadonlyMap<string, string>
  onChange: (next: Set<string>) => void
}) {
  const [search, setSearch] = React.useState('')
  const [q, setQ] = React.useState('')
  React.useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])
  const filters = { state: 'approved' as const, ...(q ? { q } : {}) }
  const query = useInfiniteQuery({
    queryKey: queryKeys.devices.infinite(filters),
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      unwrap(
        api.GET('/admin/api/v1/devices', {
          params: { query: { ...filters, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.next_cursor || undefined,
  })
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <div className="flex flex-col gap-2">
      <Input
        type="search"
        aria-label="Search devices"
        placeholder="Search approved devices"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {query.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">No approved devices match.</p>
      ) : (
        <ul className="flex max-h-56 flex-col overflow-y-auto rounded-lg border border-border">
          {items.map((device) => {
            const label = deviceName(device)
            const groupName = device.group_id ? groupNames.get(device.group_id) : undefined
            return (
              <li key={device.id} className="transition-colors hover:bg-muted/50">
                <label className="flex min-h-8 cursor-pointer items-center gap-2 px-3 py-1.5 text-sm sm:py-1 pointer-coarse:min-h-11">
                  <input
                    type="checkbox"
                    className={checkboxClass}
                    checked={deviceIds.has(device.id)}
                    onChange={(event) =>
                      onChange(toggled(deviceIds, device.id, event.target.checked))
                    }
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="truncate">{label}</span>
                      {device.alias && device.hostname && device.alias !== device.hostname && (
                        <span className="sr-only">({device.hostname})</span>
                      )}
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {device.rustdesk_id}
                      </span>
                    </span>
                    {groupName && (
                      <span
                        data-slot="device-group"
                        className="truncate text-xs text-muted-foreground sm:ml-auto sm:max-w-[45%]"
                      >
                        {groupName}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
      {query.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}

function AssignForm({
  user,
  groups,
  initial,
  onClose,
}: {
  user: User
  groups: Group[]
  initial: Grants
  onClose: () => void
}) {
  const [groupIds, setGroupIds] = React.useState<Set<string>>(new Set(initial.group_ids))
  const [deviceIds, setDeviceIds] = React.useState<Set<string>>(new Set(initial.device_ids))
  const [error, setError] = React.useState<string | null>(null)
  const groupNames = React.useMemo(() => groupNameMap(groups), [groups])
  const covered = React.useMemo(() => coveredGroupIds(groups, groupIds), [groups, groupIds])
  const directGroupCount = React.useMemo(
    () => [...groupIds].filter((id) => !covered.has(id)).length,
    [groupIds, covered],
  )
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT('/admin/api/v1/users/{id}/grants', {
          params: { path: { id: user.id } },
          body: grantsBody(groups, groupIds, deviceIds),
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.users.all(), 'grants', user.id],
      })
      toast({ title: 'Assigned devices saved' })
      onClose()
    },
    onError: (err) => setError(describeError(err).message),
  })
  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        save.mutate()
      }}
    >
      <section className="flex min-w-0 flex-col gap-1.5" aria-labelledby="assign-groups">
        <h3
          id="assign-groups"
          aria-label={`Groups, ${directGroupCount} selected`}
          className="flex items-center gap-2 text-xs font-medium text-muted-foreground"
        >
          <span>Groups</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums text-foreground">
            {directGroupCount}
          </span>
        </h3>
        <GroupList tree={groups} groupIds={groupIds} onChange={setGroupIds} />
      </section>
      <section className="flex min-w-0 flex-col gap-1.5" aria-labelledby="assign-devices">
        <h3
          id="assign-devices"
          aria-label={`Devices, ${deviceIds.size} selected`}
          className="flex items-center gap-2 text-xs font-medium text-muted-foreground"
        >
          <span>Devices</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums text-foreground">
            {deviceIds.size}
          </span>
        </h3>
        <DeviceList deviceIds={deviceIds} groupNames={groupNames} onChange={setDeviceIds} />
      </section>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function AssignBody({ user, onClose }: { user: User; onClose: () => void }) {
  const grants = useQuery({
    queryKey: [...queryKeys.users.all(), 'grants', user.id],
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/users/{id}/grants', { params: { path: { id: user.id } }, signal }),
      ),
    gcTime: 0,
  })
  const groups = useQuery(groupsQueryOptions)
  return (
    <>
      <DialogHeader>
        <DialogTitle>Assign devices to &ldquo;{user.username}&rdquo;</DialogTitle>
        <DialogDescription>
          A checked group covers its subgroups and all their devices.
        </DialogDescription>
      </DialogHeader>
      {grants.isError || groups.isError ? (
        <ErrorState
          error={grants.error ?? groups.error}
          retry={() => {
            void grants.refetch()
            void groups.refetch()
          }}
        />
      ) : grants.data && groups.data ? (
        <AssignForm
          user={user}
          groups={groups.data.items}
          initial={grants.data}
          onClose={onClose}
        />
      ) : (
        <Skeleton className="h-48 w-full" />
      )}
    </>
  )
}

export interface AssignDevicesDialogProps {
  user: User | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AssignDevicesDialog({ user, open, onOpenChange }: AssignDevicesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="assign-devices-dialog" className="sm:max-w-xl">
        {open && user && <AssignBody user={user} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}
