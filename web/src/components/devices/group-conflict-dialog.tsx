import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import type { components } from '@/api/schema'
import { MonoId } from '@/components/brand/mono-id'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { deviceName } from '@/lib/device'
import { queryKeys } from '@/lib/queryKeys'
import { groupsQueryOptions } from '@/lib/queries'
import { cn } from '@/lib/utils'

type Device = components['schemas']['Device']
type Group = components['schemas']['Group']

export interface ConflictTarget {
  deviceId: string
  initialDevice?: Device | null
}

type Listener = (target: ConflictTarget | null) => void
const listeners = new Set<Listener>()

export function openGroupConflictDialog(target: ConflictTarget) {
  for (const listener of listeners) {
    listener(target)
  }
}

export function GlobalGroupConflictDialog() {
  const [target, setTarget] = React.useState<ConflictTarget | null>(null)

  React.useEffect(() => {
    listeners.add(setTarget)
    return () => {
      listeners.delete(setTarget)
    }
  }, [])

  return (
    <GroupConflictDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setTarget(null)
      }}
      deviceId={target?.deviceId ?? null}
      initialDevice={target?.initialDevice}
    />
  )
}

function findGroupName(groups: Group[], id: string | null): string | null {
  if (!id) return null
  for (const g of groups) {
    if (g.id === id) return g.name
    if (g.children?.length) {
      const found = findGroupName(g.children, id)
      if (found) return found
    }
  }
  return null
}

export interface GroupConflictDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  deviceId: string | null
  initialDevice?: Device | null
  onResolved?: () => void
}

interface GroupConflictDialogContentProps {
  deviceId: string | null
  initialDevice?: Device | null
  onClose: () => void
  onResolved?: () => void
}

function GroupConflictDialogContent({
  deviceId,
  initialDevice,
  onClose,
  onResolved,
}: GroupConflictDialogContentProps) {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const deviceQuery = useQuery({
    queryKey: queryKeys.device(deviceId ?? undefined),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/devices/{id}', {
          params: { path: { id: deviceId! } },
          signal,
        }),
      ),
    enabled: Boolean(deviceId),
    initialData: initialDevice?.id === deviceId ? initialDevice : undefined,
    initialDataUpdatedAt: 0,
  })

  const groupsQuery = useQuery(groupsQueryOptions)

  const device = deviceQuery.data
  const allGroups = React.useMemo(() => groupsQuery.data?.items ?? [], [groupsQuery.data])
  const conflictAlert = device?.open_alerts?.find((a) => a.kind === 'group_conflict')
  const matchingGroups = React.useMemo(() => conflictAlert?.groups ?? [], [conflictAlert])

  React.useEffect(() => {
    if (!device || conflictAlert || deviceQuery.dataUpdatedAt === 0) return
    void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
    void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
  }, [conflictAlert, device, deviceQuery.dataUpdatedAt, queryClient])

  const currentGroupName = React.useMemo(() => {
    if (!device || !device.group_id) return 'No group'
    const name = findGroupName(allGroups, device.group_id)
    return name ?? 'No group'
  }, [device, allGroups])

  const defaultChoice = matchingGroups.length > 0 ? matchingGroups[0]!.id : 'keep'
  const [userChoice, setUserChoice] = React.useState<string | null>(null)
  const selectedChoice = userChoice ?? defaultChoice

  const resolveMutation = useMutation({
    mutationFn: async () => {
      if (!device) throw new Error('Device is unavailable')
      if (selectedChoice === 'keep') {
        if (!conflictAlert) {
          throw new Error('Group conflict alert is no longer open')
        }
        return unwrap(
          api.POST('/admin/api/v1/devices/{id}/alerts/{alert_id}/resolve', {
            params: { path: { id: device.id, alert_id: conflictAlert.id } },
            body: { action: 'dismiss' },
          }),
        )
      } else {
        return unwrap(
          api.PATCH('/admin/api/v1/devices/{id}', {
            params: { path: { id: device.id } },
            body: { group_id: selectedChoice },
          }),
        )
      }
    },
    onSuccess: () => {
      toast({
        title: 'Conflict resolved',
        description:
          selectedChoice === 'keep'
            ? 'Device kept in its current group.'
            : 'Device moved to selected group.',
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      if (device) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.device(device.id) })
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
      onResolved?.()
      onClose()
    },
    onError: (err) => {
      const error = describeError(err)
      if (selectedChoice === 'keep' && error.code === 'not_found') {
        toast({ title: 'Conflict already resolved' })
        void deviceQuery.refetch()
        void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
        void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
        onClose()
        return
      }
      toast({
        title: 'Could not resolve conflict',
        description: error.message,
        variant: 'destructive',
      })
    },
  })

  const handleApply = (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedChoice) return
    resolveMutation.mutate()
  }

  return (
    <DialogContent
      data-slot="group-conflict-dialog"
      className="sm:max-w-md"
      showCloseButton={!device || !!conflictAlert}
    >
      <DialogHeader>
        <DialogTitle>Resolve Group Conflict</DialogTitle>
        <DialogDescription>
          {device && !conflictAlert
            ? 'The device no longer has an open group conflict.'
            : 'This device matches rules for multiple groups. Choose which group it belongs to, or keep its current placement.'}
        </DialogDescription>
      </DialogHeader>

      {deviceQuery.isLoading && !device ? (
        <div className="flex flex-col gap-3 py-4">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : !device ? (
        <div className="py-4 text-sm text-destructive">Device could not be loaded.</div>
      ) : !conflictAlert ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">This conflict is already resolved.</p>
          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-foreground truncate">{deviceName(device)}</span>
              <MonoId idText={device.rustdesk_id} />
            </div>
            <div className="text-muted-foreground">Current placement: {currentGroupName}</div>
          </div>
          <DialogFooter>
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </div>
      ) : (
        <form onSubmit={handleApply} className="flex flex-col gap-4">
          {/* Device metadata banner */}
          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-foreground truncate">{deviceName(device)}</span>
              <MonoId idText={device.rustdesk_id} />
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <span>Hostname:</span>
              <span className="font-mono text-foreground font-medium">
                {device.hostname || '—'}
              </span>
            </div>
          </div>

          {/* Radio options for matching groups + keep where it is */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              Matching Groups
            </legend>
            {matchingGroups.map((group) => {
              const isSelected = selectedChoice === group.id
              const isCurrentGroup = device.group_id === group.id
              return (
                <label
                  key={group.id}
                  className={cn(
                    'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors text-xs',
                    isSelected
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'border-border hover:bg-muted/40',
                  )}
                >
                  <input
                    type="radio"
                    name="group-choice"
                    value={group.id}
                    checked={isSelected}
                    onChange={() => setUserChoice(group.id)}
                    className="size-4 text-primary accent-primary cursor-pointer shrink-0"
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-medium text-foreground truncate">
                      {isCurrentGroup ? `Keep in ${group.name} (current group)` : group.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {isCurrentGroup
                        ? 'Clear the conflict and keep its current group'
                        : `Move to ${group.name} and apply its client policy`}
                    </span>
                  </div>
                </label>
              )
            })}

            <label
              className={cn(
                'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors text-xs',
                selectedChoice === 'keep'
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border hover:bg-muted/40',
              )}
            >
              <input
                type="radio"
                name="group-choice"
                value="keep"
                checked={selectedChoice === 'keep'}
                onChange={() => setUserChoice('keep')}
                className="size-4 text-primary accent-primary cursor-pointer shrink-0"
              />
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium text-foreground">Keep where it is</span>
                <span className="text-xs text-muted-foreground">
                  Current placement: {currentGroupName}
                </span>
              </div>
            </label>
          </fieldset>

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={resolveMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!selectedChoice || resolveMutation.isPending}>
              {resolveMutation.isPending ? 'Applying…' : 'Apply'}
            </Button>
          </DialogFooter>
        </form>
      )}
    </DialogContent>
  )
}

export function GroupConflictDialog({
  open,
  onOpenChange,
  deviceId,
  initialDevice,
  onResolved,
}: GroupConflictDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <GroupConflictDialogContent
          deviceId={deviceId}
          initialDevice={initialDevice}
          onClose={() => onOpenChange(false)}
          onResolved={onResolved}
        />
      )}
    </Dialog>
  )
}
