import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  HelpCircleIcon,
  ListFilterIcon,
  MoreHorizontalIcon,
  MoveIcon,
  PencilIcon,
  ShieldCheckIcon,
  TagIcon,
  Trash2Icon,
} from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { useMe } from '@/auth/session'
import { EmptyState } from '@/components/brand/empty-state'
import { ErrorState } from '@/components/brand/error-state'
import { useToast } from '@/components/ui/toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'
import { queryKeys } from '@/lib/queryKeys'
import { groupsQueryOptions, summaryQueryOptions } from '@/lib/queries'
import {
  GroupCreateDialog,
  GroupDeleteDialog,
  GroupMoveDialog,
  GroupPolicyDialog,
  GroupRenameDialog,
} from './group-dialogs'
import { AutoSortDialog } from './auto-sort-dialog'
import { GroupRulesSection } from './group-rules-section'
import { IdAllowListEditor } from '@/components/settings/id-allow-list-editor'
import type { GroupStatsMap } from './group-tree'
import type { Group } from './group-utils'
import type { components } from '@/api/schema'

type Policy = components['schemas']['Policy']
type GroupRule = components['schemas']['GroupRule']

interface NearestPolicy {
  groupName: string
  policyId: string
}

function getPolicyLabel(
  group: Group,
  policies: Policy[],
  nearestAncestorPolicy: NearestPolicy | null,
): string {
  if (group.policy_id !== null) {
    const p = policies.find((item) => item.id === group.policy_id)
    return p ? p.name : 'Policy'
  }
  if (nearestAncestorPolicy !== null) {
    const p = policies.find((item) => item.id === nearestAncestorPolicy.policyId)
    const policyName = p ? p.name : 'Default'
    return `Inherited: ${policyName} (from ${nearestAncestorPolicy.groupName})`
  }
  return 'Default'
}

// Own counts plus every descendant's; null when neither the group nor a
// descendant appears in the summary (no badge).
function rollUpStats(
  group: Group,
  statsMap: GroupStatsMap,
): { online: number; total: number } | null {
  let found = false
  let online = 0
  let total = 0
  const visit = (g: Group) => {
    const own = statsMap[g.id]
    if (own !== undefined) {
      found = true
      online += own.online
      total += own.total
    }
    for (const child of g.children ?? []) visit(child)
  }
  visit(group)
  return found ? { online, total } : null
}

interface GroupRowProps {
  group: Group
  level: number
  stats?: { online: number; total: number }
  statsMap: GroupStatsMap
  policies: Policy[]
  nearestAncestorPolicy: NearestPolicy | null
  isUser: boolean
  rules: GroupRule[]
  rulesMap: Map<string, GroupRule[]>
  onAddSubgroup: (parent: Group) => void
  onRename: (group: Group) => void
  onMove: (group: Group) => void
  onDelete: (group: Group) => void
  onPolicyChange: (groupId: string, policyId: string | null) => void
  onOpenPolicyDialog: (group: Group, inheritedLabel: string) => void
}

function GroupRow({
  group,
  level,
  stats,
  statsMap,
  policies,
  nearestAncestorPolicy,
  isUser,
  rules,
  rulesMap,
  onAddSubgroup,
  onRename,
  onMove,
  onDelete,
  onPolicyChange,
  onOpenPolicyDialog,
}: GroupRowProps) {
  const [expanded, setExpanded] = React.useState(true)
  const [rulesExpanded, setRulesExpanded] = React.useState(false)
  const [allowListExpanded, setAllowListExpanded] = React.useState(false)
  const hasChildren = Boolean(group.children && group.children.length > 0)
  const rolled = rollUpStats(group, statsMap)

  const policyLabel = getPolicyLabel(group, policies, nearestAncestorPolicy)
  const nextAncestorPolicy: NearestPolicy | null =
    group.policy_id !== null
      ? { groupName: group.name, policyId: group.policy_id }
      : nearestAncestorPolicy

  const phoneIndentRem =
    level <= 0 ? 0.5 : level === 1 ? 1.5 : level === 2 ? 2.25 : level === 3 ? 2.75 : 3.0
  const desktopIndentRem = Math.max(0.5, level * 1.5)
  const phoneRulesIndentRem = phoneIndentRem
  const desktopRulesIndentRem = Math.max(0.5, level * 1.5 + 1.5)

  return (
    <div className="flex flex-col select-none" data-slot="group-node" data-group-id={group.id}>
      <div
        className="flex items-center justify-between rounded-md p-2 transition-colors hover:bg-muted/40 group gap-1.5 sm:gap-2 [padding-left:var(--phone-indent)] sm:[padding-left:var(--desktop-indent)]"
        style={
          {
            '--phone-indent': `${phoneIndentRem}rem`,
            '--desktop-indent': `${desktopIndentRem}rem`,
          } as React.CSSProperties
        }
      >
        {/* Left: toggle + folder + name + count */}
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              aria-label={expanded ? 'Collapse group' : 'Expand group'}
              className="text-muted-foreground hover:text-foreground rounded focus-visible:outline-hidden size-9 sm:size-5 inline-flex items-center justify-center shrink-0"
            >
              {expanded ? (
                <ChevronDownIcon className="size-4 shrink-0" />
              ) : (
                <ChevronRightIcon className="size-4 shrink-0" />
              )}
            </button>
          ) : (
            <span
              className="size-9 sm:size-5 shrink-0"
              aria-hidden="true"
              data-slot="group-leaf-spacer"
            />
          )}

          <FolderIcon className="size-4 text-muted-foreground shrink-0" />

          <span
            className="text-sm font-medium text-foreground truncate min-w-0"
            data-slot="group-name"
            title={group.name}
          >
            {group.name}
          </span>

          {rolled !== null && (
            <Badge
              variant="secondary"
              data-slot="group-count"
              aria-label={
                hasChildren
                  ? `${rolled.online} of ${rolled.total} devices online, including subgroups; ${stats?.total ?? 0} in this group`
                  : `${rolled.online} of ${rolled.total} devices online`
              }
              className="text-2xs h-5 px-1.5 font-normal ml-1 shrink-0 whitespace-nowrap"
            >
              <span className="font-semibold text-foreground">{rolled.online}</span>
              <span className="text-muted-foreground mx-0.5">/</span>
              <span>{rolled.total} online</span>
              {hasChildren && (
                <span className="text-muted-foreground ml-1">
                  {'· '}
                  {stats?.total ?? 0} here
                </span>
              )}
            </Badge>
          )}
        </div>

        {/* Right: Policy picker (for staff) + Actions menu */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {!isUser && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRulesExpanded(!rulesExpanded)}
              className="hidden sm:inline-flex h-7 text-xs px-2 gap-1 text-muted-foreground hover:text-foreground"
              aria-label={`Auto-sort rules for ${group.name}`}
            >
              <TagIcon className="size-3" />
              <span>Rules ({rules.length})</span>
            </Button>
          )}

          {!isUser && (
            <div className="hidden sm:block w-56">
              <Select
                value={group.policy_id ?? '__inherit__'}
                onValueChange={(val) =>
                  onPolicyChange(group.id, val === '__inherit__' ? null : val)
                }
              >
                <SelectTrigger
                  aria-label={`Policy for ${group.name}`}
                  className="h-7 text-xs w-full justify-between"
                >
                  <SelectValue>{policyLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="__inherit__" className="text-xs">
                    Inherit{' '}
                    {group.policy_id !== null && nearestAncestorPolicy
                      ? `(${getPolicyLabel({ ...group, policy_id: null }, policies, nearestAncestorPolicy)})`
                      : ''}
                  </SelectItem>
                  {policies.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="text-xs">
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 h-11 w-11 sm:h-7 sm:w-7 p-0 text-muted-foreground hover:text-foreground"
                aria-label={`Actions for group ${group.name}`}
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => onAddSubgroup(group)}>
                <FolderPlusIcon className="size-4 mr-2" />
                Add subgroup
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRename(group)}>
                <PencilIcon className="size-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onMove(group)}>
                <MoveIcon className="size-4 mr-2" />
                Move to…
              </DropdownMenuItem>
              {!isUser && (
                <DropdownMenuItem onClick={() => setRulesExpanded((prev) => !prev)}>
                  <TagIcon className="size-4 mr-2" />
                  Auto-sort rules…
                </DropdownMenuItem>
              )}
              {!isUser && (
                <DropdownMenuItem onClick={() => setAllowListExpanded((prev) => !prev)}>
                  <ListFilterIcon className="size-4 mr-2" />
                  ID allow list…
                </DropdownMenuItem>
              )}
              {!isUser && (
                <DropdownMenuItem onClick={() => onOpenPolicyDialog(group, policyLabel)}>
                  <ShieldCheckIcon className="size-4 mr-2" />
                  Assign policy…
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(group)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2Icon className="size-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Auto-Sort Rules area (owners and admins only) */}
      {!isUser && rulesExpanded && (
        <div
          style={
            {
              '--phone-rules-indent': `${phoneRulesIndentRem}rem`,
              '--desktop-rules-indent': `${desktopRulesIndentRem}rem`,
            } as React.CSSProperties
          }
          className="pr-2 pb-2 [padding-left:var(--phone-rules-indent)] sm:[padding-left:var(--desktop-rules-indent)]"
        >
          <GroupRulesSection group={group} rules={rules} />
        </div>
      )}

      {!isUser && allowListExpanded && <GroupIDAllowList group={group} />}

      {/* Render children if expanded */}
      {hasChildren && expanded && (
        <div className="flex flex-col">
          {group.children.map((child) => (
            <GroupRow
              key={child.id}
              group={child}
              level={level + 1}
              stats={statsMap[child.id]}
              statsMap={statsMap}
              policies={policies}
              nearestAncestorPolicy={nextAncestorPolicy}
              isUser={isUser}
              rules={rulesMap.get(child.id) ?? []}
              rulesMap={rulesMap}
              onAddSubgroup={onAddSubgroup}
              onRename={onRename}
              onMove={onMove}
              onDelete={onDelete}
              onPolicyChange={onPolicyChange}
              onOpenPolicyDialog={onOpenPolicyDialog}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function GroupIDAllowList({ group }: { group: Group }) {
  const client = useQueryClient()
  const queryKey = queryKeys.groupIDAllowList(group.id)
  const query = useQuery({
    queryKey,
    queryFn: () =>
      unwrap(
        api.GET('/admin/api/v1/groups/{id}/id-allow-list', { params: { path: { id: group.id } } }),
      ),
  })
  if (query.isLoading) return <Skeleton className="mx-4 mb-3 h-40" />
  if (query.error) return <ErrorState error={query.error} retry={() => void query.refetch()} />
  if (!query.data) return null
  return (
    <div className="px-4 pb-3">
      <IdAllowListEditor
        key={JSON.stringify(query.data.ids)}
        title={`${group.name} ID allow list`}
        ids={query.data.ids}
        onSave={async (ids) => {
          await unwrap(
            api.PUT('/admin/api/v1/groups/{id}/id-allow-list', {
              params: { path: { id: group.id } },
              body: { ids },
            }),
          )
          await Promise.all([
            client.invalidateQueries({ queryKey }),
            client.invalidateQueries({ queryKey: queryKeys.device() }),
          ])
        }}
      />
    </div>
  )
}

export function GroupsView() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { data: me } = useMe()
  const isUser = me?.user.role === 'user'
  const isOwner = me?.user.role === 'owner'

  // Dialog state
  const [createOpen, setCreateOpen] = React.useState(false)
  const [parentForCreate, setParentForCreate] = React.useState<Group | null>(null)
  const [autoSortOpen, setAutoSortOpen] = React.useState(false)

  const [renameOpen, setRenameOpen] = React.useState(false)
  const [groupForRename, setGroupForRename] = React.useState<Group | null>(null)

  const [moveOpen, setMoveOpen] = React.useState(false)
  const [groupForMove, setGroupForMove] = React.useState<Group | null>(null)

  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [groupForDelete, setGroupForDelete] = React.useState<Group | null>(null)

  const [policyOpen, setPolicyOpen] = React.useState(false)
  const [groupForPolicy, setGroupForPolicy] = React.useState<Group | null>(null)
  const [inheritedPolicyLabel, setInheritedPolicyLabel] = React.useState('')

  // Fetch group tree
  const groupsQuery = useQuery(groupsQueryOptions)

  // Fetch summary to map device counts per group
  const summaryQuery = useQuery(summaryQueryOptions)

  // Fetch policies (owners and admins only; Users make no /policies call)
  const policiesQuery = useQuery({
    queryKey: queryKeys.policies(),
    queryFn: ({ signal }) => unwrap(api.GET('/admin/api/v1/policies', { signal })),
    enabled: !isUser,
  })

  // Fetch group rules (owners and admins only)
  const groupRulesQuery = useQuery({
    queryKey: queryKeys.groupRules(),
    queryFn: ({ signal }) => unwrap(api.GET('/admin/api/v1/group-rules', { signal })),
    enabled: !isUser,
  })

  const rulesMap = React.useMemo(() => {
    const map = new Map<string, GroupRule[]>()
    if (groupRulesQuery.data?.items) {
      for (const rule of groupRulesQuery.data.items) {
        const existing = map.get(rule.group_id) ?? []
        existing.push(rule)
        map.set(rule.group_id, existing)
      }
    }
    return map
  }, [groupRulesQuery.data])

  const groups = groupsQuery.data?.items ?? []
  const policies = policiesQuery.data?.items ?? []

  // Mutation: set group policy
  const policyMutation = useMutation({
    mutationFn: async ({ groupId, policyId }: { groupId: string; policyId: string | null }) => {
      return unwrap(
        api.PUT('/admin/api/v1/groups/{id}/policy', {
          params: { path: { id: groupId } },
          body: { policy_id: policyId },
        }),
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups() })
      toast({ title: 'Group policy saved' })
    },
  })

  // Build stats lookup map
  const statsMap = React.useMemo<GroupStatsMap>(() => {
    const map: GroupStatsMap = {}
    if (summaryQuery.data?.groups) {
      for (const g of summaryQuery.data.groups) {
        if (g.id) {
          map[g.id] = { online: g.online, total: g.total }
        }
      }
    }
    return map
  }, [summaryQuery.data])

  // Check for ungrouped devices
  const ungroupedStats = React.useMemo(() => {
    return summaryQuery.data?.groups?.find((g) => g.id === null)
  }, [summaryQuery.data])

  const handleOpenCreateRoot = () => {
    setParentForCreate(null)
    setCreateOpen(true)
  }

  const handleAddSubgroup = (parent: Group) => {
    setParentForCreate(parent)
    setCreateOpen(true)
  }

  const handleRename = (group: Group) => {
    setGroupForRename(group)
    setRenameOpen(true)
  }

  const handleMove = (group: Group) => {
    setGroupForMove(group)
    setMoveOpen(true)
  }

  const handleDelete = (group: Group) => {
    setGroupForDelete(group)
    setDeleteOpen(true)
  }

  const handlePolicyChange = (groupId: string, policyId: string | null) => {
    policyMutation.mutate({ groupId, policyId })
  }

  const handleOpenPolicyDialog = (group: Group, inheritedLabel: string) => {
    setGroupForPolicy(group)
    setInheritedPolicyLabel(inheritedLabel)
    setPolicyOpen(true)
  }

  return (
    <div className="flex flex-col gap-6 w-full p-0 sm:p-6" data-slot="groups-page">
      <PageHeader
        title="Groups"
        description="Organize devices into a tree for filtering and the fleet overview."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isOwner && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setAutoSortOpen(true)}
                className="min-h-[44px] sm:min-h-0 h-11 sm:h-8"
              >
                Auto Sort All
              </Button>
            )}
            <Button
              onClick={handleOpenCreateRoot}
              size="sm"
              className="gap-1.5 min-h-[44px] sm:min-h-0 h-11 sm:h-8"
            >
              <FolderPlusIcon className="size-4" />
              <span>New group</span>
            </Button>
          </div>
        }
      />

      {/* Main Content */}
      {groupsQuery.isLoading ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : groupsQuery.isError ? (
        <ErrorState error={groupsQuery.error} retry={() => void groupsQuery.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState
          title="No groups created yet"
          description="Groups help you organize your fleet by department, location, or environment."
          action={
            <Button
              onClick={handleOpenCreateRoot}
              size="sm"
              className="gap-1.5 min-h-[44px] sm:min-h-0 h-11 sm:h-8"
            >
              <FolderPlusIcon className="size-4" />
              <span>Create first group</span>
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-card p-2 divide-y divide-border/30">
            {groups.map((root) => (
              <GroupRow
                key={root.id}
                group={root}
                level={0}
                stats={statsMap[root.id]}
                statsMap={statsMap}
                policies={policies}
                nearestAncestorPolicy={null}
                isUser={isUser}
                rules={rulesMap.get(root.id) ?? []}
                rulesMap={rulesMap}
                onAddSubgroup={handleAddSubgroup}
                onRename={handleRename}
                onMove={handleMove}
                onDelete={handleDelete}
                onPolicyChange={handlePolicyChange}
                onOpenPolicyDialog={handleOpenPolicyDialog}
              />
            ))}
          </div>

          {/* Ungrouped devices row if any exist */}
          {ungroupedStats && ungroupedStats.total > 0 && (
            <div
              data-slot="ungrouped-devices-card"
              className="flex flex-col sm:flex-row sm:items-center justify-between rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-3 gap-2"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <HelpCircleIcon className="size-4 text-muted-foreground shrink-0" />
                <Link
                  to="/devices"
                  search={{ group: 'ungrouped' }}
                  className="text-sm font-medium text-muted-foreground hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                >
                  Ungrouped devices
                </Link>
                <Badge
                  variant="outline"
                  className="text-2xs h-5 px-1.5 font-normal shrink-0 whitespace-nowrap"
                >
                  <span className="font-semibold text-foreground">{ungroupedStats.online}</span>
                  <span className="text-muted-foreground mx-0.5">/</span>
                  <span>{ungroupedStats.total} online</span>
                </Badge>
              </div>
              <span className="text-xs text-muted-foreground">
                Assign a group from the device details panel.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Dialogs */}
      <GroupCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        parentGroup={parentForCreate}
      />

      <GroupRenameDialog group={groupForRename} open={renameOpen} onOpenChange={setRenameOpen} />

      <GroupMoveDialog
        group={groupForMove}
        tree={groups}
        open={moveOpen}
        onOpenChange={setMoveOpen}
      />

      <GroupDeleteDialog group={groupForDelete} open={deleteOpen} onOpenChange={setDeleteOpen} />

      <GroupPolicyDialog
        group={groupForPolicy}
        open={policyOpen}
        onOpenChange={setPolicyOpen}
        policies={policies}
        inheritedPolicyLabel={inheritedPolicyLabel}
      />

      <AutoSortDialog open={autoSortOpen} onOpenChange={setAutoSortOpen} />
    </div>
  )
}
