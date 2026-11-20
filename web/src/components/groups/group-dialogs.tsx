import * as React from 'react'
import type { components } from '@/api/schema'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { queryKeys } from '@/lib/queryKeys'
import { useToast } from '@/components/ui/toast'
import { flattenGroups, getDescendantIds, mapGroupError, type Group } from './group-utils'

// ---- Common invalidation on group mutation success ----
function useInvalidateGroups() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups() })
    void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
    void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
  }
}

// -------------------------------------------------------------
// 1. GroupCreateDialog
// -------------------------------------------------------------
export interface GroupCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentGroup?: Group | null
}

function CreateForm({ parentGroup, onClose }: { parentGroup?: Group | null; onClose: () => void }) {
  const [name, setName] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const invalidate = useInvalidateGroups()
  const { toast } = useToast()

  // Find all ineligible destinations (self + descendants)

  const createMutation = useMutation({
    mutationFn: (groupName: string) =>
      unwrap(
        api.POST('/admin/api/v1/groups', {
          body: {
            name: groupName,
            parent_id: parentGroup ? parentGroup.id : null,
          },
        }),
      ),
    onSuccess: () => {
      invalidate()
      toast({ title: 'Group created' })
      onClose()
    },
    onError: (err) => {
      setError(mapGroupError(err))
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setError(null)
    createMutation.mutate(trimmed)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {parentGroup ? `Add subgroup under "${parentGroup.name}"` : 'Create new group'}
        </DialogTitle>
        <DialogDescription>
          {parentGroup
            ? 'Enter a name for the new subgroup.'
            : 'Enter a name for the new top-level group.'}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="group-create-name" className="text-xs font-medium text-muted-foreground">
            Group name
          </label>
          <Input
            id="group-create-name"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'group-create-error' : undefined}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Engineering"
            maxLength={128}
            required
            autoFocus
          />
        </div>

        {error && (
          <p id="group-create-error" role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={createMutation.isPending}
            className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!name.trim() || createMutation.isPending}
            className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
          >
            {createMutation.isPending ? 'Creating…' : 'Create group'}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

export function GroupCreateDialog({ open, onOpenChange, parentGroup }: GroupCreateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="group-create-dialog" className="max-h-[90vh] overflow-y-auto">
        {open && <CreateForm parentGroup={parentGroup} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

// -------------------------------------------------------------
// 2. GroupRenameDialog
// -------------------------------------------------------------
export interface GroupRenameDialogProps {
  group: Group | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

function RenameForm({ group, onClose }: { group: Group; onClose: () => void }) {
  const [name, setName] = React.useState(group.name)
  const [error, setError] = React.useState<string | null>(null)
  const invalidate = useInvalidateGroups()
  const { toast } = useToast()

  // Find all ineligible destinations (self + descendants)

  const renameMutation = useMutation({
    mutationFn: (newName: string) =>
      unwrap(
        api.PATCH('/admin/api/v1/groups/{id}', {
          params: { path: { id: group.id } },
          body: { name: newName },
        }),
      ),
    onSuccess: () => {
      invalidate()
      toast({ title: 'Group saved' })
      onClose()
    },
    onError: (err) => {
      setError(mapGroupError(err))
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setError(null)
    renameMutation.mutate(trimmed)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename group</DialogTitle>
        <DialogDescription>Change the name of &ldquo;{group.name}&rdquo;.</DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="group-rename-name" className="text-xs font-medium text-muted-foreground">
            Group name
          </label>
          <Input
            id="group-rename-name"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'group-rename-error' : undefined}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Infrastructure"
            maxLength={128}
            required
            autoFocus
          />
        </div>

        {error && (
          <p id="group-rename-error" role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={renameMutation.isPending}
            className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!name.trim() || renameMutation.isPending}
            className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
          >
            {renameMutation.isPending ? 'Saving…' : 'Rename'}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

export function GroupRenameDialog({ group, open, onOpenChange }: GroupRenameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="group-rename-dialog" className="max-h-[90vh] overflow-y-auto">
        {open && group && <RenameForm group={group} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

// -------------------------------------------------------------
// 3. GroupMoveDialog (Keyboard accessible destination picker)
// -------------------------------------------------------------
export interface GroupMoveDialogProps {
  group: Group | null
  tree: Group[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

function MoveForm({ group, tree, onClose }: { group: Group; tree: Group[]; onClose: () => void }) {
  const [selectedParentId, setSelectedParentId] = React.useState<string>(
    group.parent_id ?? '__top__',
  )
  const [error, setError] = React.useState<string | null>(null)
  const invalidate = useInvalidateGroups()
  const { toast } = useToast()

  // Find all ineligible destinations (self + descendants)
  const descendantIds = React.useMemo(() => getDescendantIds(group), [group])

  // Flatten tree excluding self and descendants
  const eligibleDestinations = React.useMemo(() => {
    const all = flattenGroups(tree)
    return all.filter((item) => !descendantIds.has(item.group.id))
  }, [tree, descendantIds])

  const moveMutation = useMutation({
    mutationFn: (targetParentId: string | null) =>
      unwrap(
        api.POST('/admin/api/v1/groups/{id}/move', {
          params: { path: { id: group.id } },
          body: { parent_id: targetParentId },
        }),
      ),
    onSuccess: () => {
      invalidate()
      toast({ title: 'Group moved' })
      onClose()
    },
    onError: (err) => {
      setError(mapGroupError(err))
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const targetParent = selectedParentId === '__top__' ? null : selectedParentId
    moveMutation.mutate(targetParent)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Move group</DialogTitle>
        <DialogDescription>
          Choose a new parent for &ldquo;{group.name}&rdquo;. Descendant groups cannot be selected.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="group-move-parent" className="text-xs font-medium text-muted-foreground">
            New location
          </label>
          <Select value={selectedParentId} onValueChange={(val) => setSelectedParentId(val)}>
            <SelectTrigger
              id="group-move-parent"
              className="w-full"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'group-move-error' : undefined}
            >
              <SelectValue placeholder="Select destination" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__top__">Top level (no parent)</SelectItem>
              {eligibleDestinations.map(({ group: dest, depth }) => (
                <SelectItem key={dest.id} value={dest.id}>
                  {'\u00A0\u00A0'.repeat(depth)}
                  {depth > 0 ? '└ ' : ''}
                  {dest.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error && (
          <p id="group-move-error" role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={moveMutation.isPending}
            className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={moveMutation.isPending}
            className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
          >
            {moveMutation.isPending ? 'Moving…' : 'Move group'}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

export function GroupMoveDialog({ group, tree, open, onOpenChange }: GroupMoveDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="group-move-dialog" className="max-h-[90vh] overflow-y-auto">
        {open && group && (
          <MoveForm group={group} tree={tree} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

// -------------------------------------------------------------
// 4. GroupDeleteDialog
// -------------------------------------------------------------
export interface GroupDeleteDialogProps {
  group: Group | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

function DeleteForm({ group, onClose }: { group: Group; onClose: () => void }) {
  const [error, setError] = React.useState<string | null>(null)
  const invalidate = useInvalidateGroups()

  const deleteMutation = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/admin/api/v1/groups/{id}', {
          params: { path: { id: group.id } },
        }),
      ),
    onSuccess: () => {
      invalidate()
      onClose()
    },
    onError: (err) => {
      setError(mapGroupError(err))
    },
  })

  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete group</DialogTitle>
        <DialogDescription>
          Are you sure you want to delete &ldquo;{group.name}&rdquo;? The group must have no
          subgroups or devices.
        </DialogDescription>
      </DialogHeader>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={deleteMutation.isPending}
          className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => deleteMutation.mutate()}
          disabled={deleteMutation.isPending}
          className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
        >
          {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
        </Button>
      </DialogFooter>
    </>
  )
}

export function GroupDeleteDialog({ group, open, onOpenChange }: GroupDeleteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="group-delete-dialog" className="max-h-[90vh] overflow-y-auto">
        {open && group && <DeleteForm group={group} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

// -------------------------------------------------------------
// 5. GroupPolicyDialog
// -------------------------------------------------------------
type Policy = components['schemas']['Policy']

export interface GroupPolicyDialogProps {
  group: Group | null
  open: boolean
  onOpenChange: (open: boolean) => void
  policies: Policy[]
  inheritedPolicyLabel?: string
}

function PolicyForm({
  group,
  policies,
  inheritedPolicyLabel,
  onClose,
}: {
  group: Group
  policies: Policy[]
  inheritedPolicyLabel?: string
  onClose: () => void
}) {
  const [selectedPolicyId, setSelectedPolicyId] = React.useState<string>(
    group.policy_id ?? '__inherit__',
  )
  const [error, setError] = React.useState<string | null>(null)
  const invalidate = useInvalidateGroups()
  const { toast } = useToast()

  // Find all ineligible destinations (self + descendants)

  const policyMutation = useMutation({
    mutationFn: (policyId: string | null) =>
      unwrap(
        api.PUT('/admin/api/v1/groups/{id}/policy', {
          params: { path: { id: group.id } },
          body: {
            policy_id: policyId,
          },
        }),
      ),
    onSuccess: () => {
      invalidate()
      toast({ title: 'Group policy saved' })
      onClose()
    },
    onError: (err) => {
      setError(mapGroupError(err))
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const policyId = selectedPolicyId === '__inherit__' ? null : selectedPolicyId
    policyMutation.mutate(policyId)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Assign policy to &ldquo;{group.name}&rdquo;</DialogTitle>
        <DialogDescription>
          Choose a client policy for this group, or inherit from its parent group.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="group-policy-select"
            className="text-xs font-medium text-muted-foreground"
          >
            Policy
          </label>
          <Select
            value={selectedPolicyId}
            onValueChange={setSelectedPolicyId}
            disabled={policyMutation.isPending}
          >
            <SelectTrigger
              id="group-policy-select"
              aria-label={`Policy for ${group.name}`}
              className="w-full text-xs"
            >
              <SelectValue placeholder="Select policy" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__inherit__" className="text-xs">
                Inherit {inheritedPolicyLabel ? `(${inheritedPolicyLabel})` : ''}
              </SelectItem>
              {policies.map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={policyMutation.isPending}
            className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={policyMutation.isPending}
            className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
          >
            {policyMutation.isPending ? 'Saving…' : 'Save policy'}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

export function GroupPolicyDialog({
  group,
  open,
  onOpenChange,
  policies,
  inheritedPolicyLabel,
}: GroupPolicyDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="group-policy-dialog" className="max-h-[90vh] overflow-y-auto">
        {open && group && (
          <PolicyForm
            group={group}
            policies={policies}
            inheritedPolicyLabel={inheritedPolicyLabel}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
