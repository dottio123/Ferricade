import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, FolderIcon, PlusIcon, TagIcon, Trash2Icon, XIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import type { components } from '@/api/schema'
import { meQuery } from '@/auth/session'
import { isSignInPending } from '@/auth/unauthorized'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/toast'
import { runWithConcurrency } from '@/lib/bulk'
import { queryKeys } from '@/lib/queryKeys'
import { groupsQueryOptions } from '@/lib/queries'
import { toCss } from '@/lib/tagColor'
import { cn } from '@/lib/utils'
import { deviceName } from '@/lib/device'
import { GroupPicker } from '@/components/groups/group-tree-picker'
import { useRejectDevices } from './use-reject-devices'
import { useApproveDevices } from './use-approve-devices'
import { ApproveConfirmDialog } from './approve-confirm-dialog'

export type Device = components['schemas']['Device']

export interface BulkActionBarProps {
  selectedDevices: Device[]
  queue?: {
    devices: Device[]
    selectedCount: number
    allSelected: boolean
    onToggleSelectAll: () => void
    onRunningChange: (running: boolean) => void
  }
  tags: components['schemas']['Tag'][]
  onClearSelection: () => void
  className?: string
}

export function formatSkippedReason(
  skippedDevices: Device[],
  actionName:
    'approve' | 'reject' | 'archive' | 'restore' | 'addTag' | 'removeTag' | 'moveGroup' | 'delete',
  targetTag?: components['schemas']['Tag'],
): string {
  if (skippedDevices.length === 0) return ''
  if (actionName === 'addTag') {
    return `already tagged ${targetTag?.name ?? ''}`
  }
  if (actionName === 'removeTag') {
    return `did not have tag ${targetTag?.name ?? ''}`
  }

  const countsByState: Record<string, number> = {}
  for (const d of skippedDevices) {
    let key: string = d.state
    if (actionName === 'approve' && d.state === 'approved') {
      key = 'already approved'
    } else if (actionName === 'reject' && d.state === 'rejected') {
      key = 'already rejected'
    } else if (actionName === 'archive' && d.state === 'archived') {
      key = 'already archived'
    } else if (actionName === 'restore' && d.state === 'approved') {
      key = 'already approved'
    }
    countsByState[key] = (countsByState[key] ?? 0) + 1
  }

  const parts = Object.entries(countsByState).map(([state, count]) => {
    return skippedDevices.length === count ? state : `${count} ${state}`
  })

  return parts.join(', ')
}

function findGroupInTree(
  groups: components['schemas']['Group'][],
  id: string,
): components['schemas']['Group'] | null {
  for (const g of groups) {
    if (g.id === id) return g
    if (g.children?.length) {
      const found = findGroupInTree(g.children, id)
      if (found) return found
    }
  }
  return null
}

interface BulkMoveGroupDialogProps {
  devices: Device[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (targetGroupId: string) => void
  busy: boolean
}

function BulkMoveGroupDialog({
  devices,
  open,
  onOpenChange,
  onConfirm,
  busy,
}: BulkMoveGroupDialogProps) {
  const [targetGroupId, setTargetGroupId] = React.useState<string | null>(null)
  const groupsQuery = useQuery({ ...groupsQueryOptions, enabled: open })
  const groups = groupsQuery.data?.items ?? []
  const targetGroup = targetGroupId ? findGroupInTree(groups, targetGroupId) : null

  return (
    <Dialog open={open} onOpenChange={(val) => !busy && onOpenChange(val)}>
      <DialogContent data-slot="bulk-move-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move to Group</DialogTitle>
          <DialogDescription>
            {devices.length === 1 ? '1 device' : `${devices.length} devices`} will move to{' '}
            <span className="font-semibold text-foreground">
              {targetGroup?.name ?? 'the selected group'}
            </span>{' '}
            and take its client policy.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <label className="text-xs font-medium text-muted-foreground block mb-1.5">
            Target group
          </label>
          <GroupPicker
            groups={groups}
            value={targetGroupId}
            onChange={setTargetGroupId}
            noneLabel="Select a group…"
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (targetGroupId) {
                onConfirm(targetGroupId)
              }
            }}
            disabled={!targetGroupId || busy}
          >
            {busy ? 'Moving…' : 'Move devices'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface BulkDeleteDialogProps {
  devices: Device[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  busy: boolean
}

function BulkDeleteDialog({ devices, open, onOpenChange, onConfirm, busy }: BulkDeleteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(val) => !busy && onOpenChange(val)}>
      <DialogContent data-slot="bulk-delete-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Delete {devices.length === 1 ? '1 device' : `${devices.length} devices`}?
          </DialogTitle>
          <DialogDescription>
            Delete {devices.length === 1 ? '1 device' : `${devices.length} devices`}? Their session
            history is deleted too. Devices that report in again enroll as new pending devices.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function BulkActionBar({
  selectedDevices: selection,
  queue,
  tags,
  onClearSelection,
  className,
}: BulkActionBarProps) {
  const selectedDevices = queue && queue.selectedCount === 0 ? queue.devices : selection
  const queryClient = useQueryClient()
  const { data: me } = useQuery({ ...meQuery, enabled: () => !queue && !isSignInPending() })
  const isUser = me?.user.role === 'user'
  const { toast } = useToast()
  const rejectDevices = useRejectDevices()
  const approveDevices = useApproveDevices()
  const [confirmDevices, setConfirmDevices] = React.useState<Device[]>([])
  const [moveGroupOpen, setMoveGroupOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  const [isRunning, setRunning] = React.useState(false)
  const setIsRunning = (running: boolean) => {
    setRunning(running)
    queue?.onRunningChange(running)
  }
  const [progress, setProgress] = React.useState<{ completed: number; total: number } | null>(null)

  // Applicable counts for selected devices
  const applicableApprove = React.useMemo(
    () => selectedDevices.filter((d) => d.state === 'pending' || d.state === 'rejected'),
    [selectedDevices],
  )
  const applicableReject = React.useMemo(
    () => selectedDevices.filter((d) => d.state === 'pending'),
    [selectedDevices],
  )
  const applicableArchive = React.useMemo(
    () => selectedDevices.filter((d) => d.state === 'approved'),
    [selectedDevices],
  )
  const applicableRestore = React.useMemo(
    () => selectedDevices.filter((d) => d.state === 'archived'),
    [selectedDevices],
  )

  // Tags applicable to remove (present on at least one selected device)
  const removableTags = React.useMemo(() => {
    const set = new Set<string>()
    for (const d of selectedDevices) {
      for (const t of d.tags) {
        set.add(t.id)
      }
    }
    return tags.filter((t) => set.has(t.id))
  }, [selectedDevices, tags])

  const executeBulkAction = async (
    actionName:
      | 'approve'
      | 'reject'
      | 'archive'
      | 'restore'
      | 'addTag'
      | 'removeTag'
      | 'moveGroup'
      | 'delete',
    targetTag?: components['schemas']['Tag'],
    targetGroupId?: string,
    confirmedDevices?: Device[],
  ) => {
    let targets: Device[] = []
    let pastAction = ''

    if (actionName === 'approve') {
      targets = confirmedDevices ?? applicableApprove
      pastAction = 'approved'
    } else if (actionName === 'reject') {
      targets = applicableReject
      pastAction = 'rejected'
    } else if (actionName === 'archive') {
      targets = applicableArchive
      pastAction = 'archived'
    } else if (actionName === 'restore') {
      targets = applicableRestore
      pastAction = 'restored'
    } else if (actionName === 'moveGroup' && targetGroupId) {
      targets = selectedDevices
      pastAction = 'moved'
    } else if (actionName === 'delete') {
      targets = selectedDevices
      pastAction = 'deleted'
    } else if (actionName === 'addTag' && targetTag) {
      targets = selectedDevices.filter((d) => !d.tags.some((t) => t.id === targetTag.id))
      pastAction = `tagged with ${targetTag.name}`
    } else if (actionName === 'removeTag' && targetTag) {
      targets = selectedDevices.filter((d) => d.tags.some((t) => t.id === targetTag.id))
      pastAction = `untagged from ${targetTag.name}`
    }

    const targetSet = new Set(targets.map((t) => t.id))
    const skippedDevices = selectedDevices.filter((d) => !targetSet.has(d.id))
    const skippedCount = skippedDevices.length
    const skippedReason = formatSkippedReason(skippedDevices, actionName, targetTag)

    if (targets.length === 0) {
      if (queue) return
      toast({
        title: 'No applicable devices',
        description: `None of the selected devices can be ${pastAction || actionName}.`,
        variant: 'default',
      })
      return
    }

    setIsRunning(true)
    setProgress({ completed: 0, total: targets.length })
    const isRejectAction = actionName === 'reject'
    const isApproveAction = actionName === 'approve'

    const { success, failed } = isRejectAction
      ? await rejectDevices.rejectMany(targets, (completed, total) =>
          setProgress({ completed, total }),
        )
      : isApproveAction
        ? await approveDevices.approve(
            targets,
            (completed, total) => setProgress({ completed, total }),
            undefined,
            { suppressConflictDialog: !queue },
          )
        : await runWithConcurrency(
            targets,
            4,
            async (device) => {
              if (actionName === 'archive') {
                return unwrap(
                  api.POST('/admin/api/v1/devices/{id}/archive', {
                    params: { path: { id: device.id } },
                  }),
                )
              } else if (actionName === 'restore') {
                return unwrap(
                  api.POST('/admin/api/v1/devices/{id}/restore', {
                    params: { path: { id: device.id } },
                  }),
                )
              } else if (actionName === 'moveGroup' && targetGroupId) {
                return unwrap(
                  api.PATCH('/admin/api/v1/devices/{id}', {
                    params: { path: { id: device.id } },
                    body: { group_id: targetGroupId },
                  }),
                )
              } else if (actionName === 'delete') {
                return unwrap(
                  api.DELETE('/admin/api/v1/devices/{id}', {
                    params: { path: { id: device.id } },
                  }),
                )
              } else if (actionName === 'addTag' && targetTag) {
                const newTagIds = Array.from(
                  new Set([...device.tags.map((t) => t.id), targetTag.id]),
                )
                return unwrap(
                  api.PATCH('/admin/api/v1/devices/{id}', {
                    params: { path: { id: device.id } },
                    body: { tag_ids: newTagIds },
                  }),
                )
              } else if (actionName === 'removeTag' && targetTag) {
                const newTagIds = device.tags.map((t) => t.id).filter((id) => id !== targetTag.id)
                return unwrap(
                  api.PATCH('/admin/api/v1/devices/{id}', {
                    params: { path: { id: device.id } },
                    body: { tag_ids: newTagIds },
                  }),
                )
              }
            },
            (completed, total) => setProgress({ completed, total }),
          )

    // Invalidate ONCE at the end
    if (
      queue
        ? isApproveAction || (failed.length > 0 && success.length === 0)
        : !isRejectAction && !isApproveAction
    ) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.summary() }),
        ...(actionName === 'moveGroup'
          ? [queryClient.invalidateQueries({ queryKey: queryKeys.groups() })]
          : []),
      ])
    }

    setIsRunning(false)
    setProgress(null)
    onClearSelection()

    // Build summary message
    const capitalizedAction = pastAction.charAt(0).toUpperCase() + pastAction.slice(1)
    const countMessage = `${capitalizedAction} ${success.length} of ${targets.length}`
    const skippedMessage = skippedCount > 0 ? ` · ${skippedCount} skipped (${skippedReason})` : ''

    if (failed.length === 0 && ((!isRejectAction && !isApproveAction) || skippedCount > 0)) {
      toast({
        title: `${countMessage}${skippedMessage}`,
        variant: 'default',
      })
    } else if (failed.length > 0) {
      const errorSummaries = failed.map(({ item, error }) => {
        const desc = describeError(error)
        const name = deviceName(item)
        if (desc.code === 'bad_transition') {
          return `${name} can't be ${pastAction} while it is ${item.state}.`
        }
        if (desc.code === 'window_open') {
          return `${name}: ${desc.message || 'close the access window first'}`
        }
        return `${name}: ${desc.message}`
      })

      toast({
        title: `${countMessage}${skippedMessage}`,
        description: errorSummaries.join(' '),
        variant: 'destructive',
      })
    }
  }

  const approveDialog = (
    <ApproveConfirmDialog
      devices={confirmDevices}
      busy={isRunning}
      onCancel={() => setConfirmDevices([])}
      onApprove={() => {
        setConfirmDevices([])
        void executeBulkAction('approve', undefined, undefined, queue ? confirmDevices : undefined)
      }}
    />
  )

  if (queue)
    return (
      <div
        data-slot="queue-bulk-toolbar"
        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-2 text-xs"
      >
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer font-medium text-foreground">
            <input
              type="checkbox"
              aria-label="Select all visible devices"
              checked={queue.allSelected}
              onChange={queue.onToggleSelectAll}
              disabled={isRunning}
              className="size-4 rounded border-input text-primary-text focus:ring-ring cursor-pointer"
            />
            <span>Select all visible ({queue.devices.length})</span>
          </label>
          {queue.selectedCount > 0 && (
            <span className="text-muted-foreground font-semibold">
              � {queue.selectedCount} selected
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {progress && (
            <span className="text-muted-foreground mr-2 font-medium">
              Processing {progress.completed} of {progress.total}�
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void executeBulkAction('reject')}
            disabled={isRunning}
            className="h-7 text-xs text-status-alert hover:bg-status-alert/10 hover:text-status-alert"
          >
            <XIcon className="size-3 mr-1" />
            Reject{queue.selectedCount === 0 ? ' all' : ''} (
            {queue.selectedCount || queue.devices.length})
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setConfirmDevices(selectedDevices)}
            disabled={isRunning}
            className="h-7 text-xs"
          >
            <CheckIcon className="size-3 mr-1" />
            Approve{queue.selectedCount === 0 ? ' all' : ''} (
            {queue.selectedCount || queue.devices.length})
          </Button>
        </div>
        {approveDialog}
      </div>
    )

  if (selectedDevices.length === 0) return null

  return (
    <div
      data-slot="bulk-action-bar"
      className={cn(
        'sticky top-[var(--app-header-h,0px)] z-20 flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/20 bg-primary/10 px-4 py-2.5 shadow-sm backdrop-blur-md',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold text-foreground">
          {selectedDevices.length} selected
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClearSelection}
          disabled={isRunning}
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3.5 mr-1" />
          Deselect all
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {progress && (
          <span className="text-xs font-medium text-muted-foreground mr-2">
            Processing {progress.completed} of {progress.total}…
          </span>
        )}

        {/* Approve */}
        {applicableApprove.length > 0 && (
          <Button
            type="button"
            size="sm"
            onClick={() => setConfirmDevices(applicableApprove)}
            disabled={isRunning}
            className="h-7 text-xs"
          >
            <CheckIcon className="size-3 mr-1" />
            Approve ({applicableApprove.length})
          </Button>
        )}

        {/* Reject */}
        {applicableReject.length > 0 && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => void executeBulkAction('reject')}
            disabled={isRunning}
            className="h-7 text-xs"
          >
            <XIcon className="size-3 mr-1" />
            Reject ({applicableReject.length})
          </Button>
        )}

        {/* Archive */}
        {applicableArchive.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void executeBulkAction('archive')}
            disabled={isRunning}
            className="h-7 text-xs"
          >
            Archive ({applicableArchive.length})
          </Button>
        )}

        {/* Restore */}
        {applicableRestore.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void executeBulkAction('restore')}
            disabled={isRunning}
            className="h-7 text-xs"
          >
            Restore ({applicableRestore.length})
          </Button>
        )}

        {/* Bulk Tag Add Dropdown */}
        {tags.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isRunning}
                className="h-7 text-xs gap-1"
              >
                <PlusIcon className="size-3" />
                <TagIcon className="size-3" />
                <span>Add tag</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {tags.map((tag) => (
                <DropdownMenuItem
                  key={tag.id}
                  onClick={() => void executeBulkAction('addTag', tag)}
                  className="text-xs flex items-center gap-2 cursor-pointer"
                >
                  <span
                    className="size-2 rounded-full shrink-0"
                    style={{ backgroundColor: toCss(tag.color) }}
                  />
                  <span>{tag.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Bulk Tag Remove Dropdown */}
        {removableTags.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isRunning}
                className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
              >
                <Trash2Icon className="size-3" />
                <span>Remove tag</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {removableTags.map((tag) => (
                <DropdownMenuItem
                  key={tag.id}
                  onClick={() => void executeBulkAction('removeTag', tag)}
                  className="text-xs flex items-center gap-2 cursor-pointer"
                >
                  <span
                    className="size-2 rounded-full shrink-0"
                    style={{ backgroundColor: toCss(tag.color) }}
                  />
                  <span>{tag.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Move to Group (owners and admins) */}
        {!isUser && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMoveGroupOpen(true)}
            disabled={isRunning}
            className="h-7 text-xs"
          >
            <FolderIcon className="size-3 mr-1" />
            Move to group ({selectedDevices.length})
          </Button>
        )}

        {/* Delete (owners and admins) */}
        {!isUser && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setDeleteOpen(true)}
            disabled={isRunning}
            className="h-7 text-xs"
          >
            <Trash2Icon className="size-3 mr-1" />
            Delete ({selectedDevices.length})
          </Button>
        )}
      </div>
      {approveDialog}
      {!isUser && (
        <>
          <BulkMoveGroupDialog
            devices={selectedDevices}
            open={moveGroupOpen}
            onOpenChange={setMoveGroupOpen}
            onConfirm={(targetGroupId) => {
              setMoveGroupOpen(false)
              void executeBulkAction('moveGroup', undefined, targetGroupId)
            }}
            busy={isRunning}
          />
          <BulkDeleteDialog
            devices={selectedDevices}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            onConfirm={() => {
              setDeleteOpen(false)
              void executeBulkAction('delete')
            }}
            busy={isRunning}
          />
        </>
      )}
    </div>
  )
}
