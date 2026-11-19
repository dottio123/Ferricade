import { DeviceConnectSection, useDeviceConnect } from './device-connect-section'
import { DeviceRecentSessions } from './device-recent-sessions'
import { DeviceRecentAudit } from './device-recent-audit'
import { useAuditActorResolver } from '@/features/audit/actor'
import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangleIcon, CheckIcon, PlusIcon, StarIcon, XIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { useRole } from '@/auth/role'
import { ApiError, describeError } from '@/api/errors'
import type { components } from '@/api/schema'
import { ErrorState } from '@/components/brand/error-state'
import { MonoId } from '@/components/brand/mono-id'
import { RelativeTime } from '@/components/brand/relative-time'
import { StatusDot } from '@/components/brand/status-dot'
import { PIN_LIMIT } from '@/features/dashboard/preferences'
import { useRawPreferences, useUpdatePreferences } from '@/features/dashboard/use-preferences'
import { Badge } from '@/components/ui/badge'
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
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { queryKeys } from '@/lib/queryKeys'
import { groupsQueryOptions } from '@/lib/queries'
import { useRejectDevices } from './use-reject-devices'
import { useApproveDevices } from './use-approve-devices'
import { ApproveRejectActions } from './approve-reject-actions'
import { textColorFor, toCss } from '@/lib/tagColor'
import { useAllTags } from '@/lib/tags'
import { cn } from '@/lib/utils'
import { deviceName, deviceStatus } from '@/lib/device'
import { GroupPicker, groupPaths } from '@/components/groups/group-tree-picker'
import { TagFormDialog } from '@/components/tags/tag-dialogs'
import { DevicePolicySection } from './device-policy-section'
import { DeviceIDAllowListSection } from './device-id-allow-list-section'
import { openGroupConflictDialog } from './group-conflict-dialog'

export type Device = components['schemas']['Device']

export interface DeviceDetailProps {
  deviceId: string
  onClose?: () => void
  className?: string
}

function formatAlertTime(iso?: string | null): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch {
    return iso
  }
}

export function DeviceDetail({ deviceId, onClose, className }: DeviceDetailProps) {
  const queryClient = useQueryClient()
  // A User reads the device, its sessions and their own audit entries, and connects.
  const readOnly = useRole() === 'user'
  const { resolveActor } = useAuditActorResolver()
  const { toast } = useToast()

  // Fetch device details
  const {
    data: device,
    isLoading,
    isLoadingError,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.device(deviceId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/devices/{id}', {
          params: { path: { id: deviceId } },
          signal,
        }),
      ),
  })

  const { data: policyStatus } = useQuery({
    queryKey: queryKeys.devicePolicy(deviceId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/devices/{id}/policy', {
          params: { path: { id: deviceId } },
          signal,
        }),
      ),
    enabled: device?.state === 'approved',
  })

  // Fetch groups tree
  const groupsQuery = useQuery(groupsQueryOptions)

  // Fetch tags list
  const tagsQuery = useAllTags()

  // Fetch recent sessions
  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions.list({ device_id: deviceId, limit: 10 }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/sessions', {
          params: { query: { device_id: deviceId, limit: 10 } },
          signal,
        }),
      ),
  })

  // Fetch recent audit logs
  const auditQuery = useQuery({
    queryKey: queryKeys.audit.list({ target: deviceId, limit: 10 }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/audit', {
          params: { query: { target: deviceId, limit: 10 } },
          signal,
        }),
      ),
  })

  const preferencesQuery = useRawPreferences()
  const { togglePin } = useUpdatePreferences()
  const isPinned = preferencesQuery.data?.pinned_device_ids.includes(deviceId) ?? false
  const isPinLimitReached = (preferencesQuery.data?.pinned_device_ids.length ?? 0) >= PIN_LIMIT
  const handleTogglePin = () => togglePin(deviceId)

  const groupTree = React.useMemo(() => groupsQuery.data?.items ?? [], [groupsQuery.data])
  const groupPathById = React.useMemo(() => groupPaths(groupTree), [groupTree])

  // Form state for editable fields
  const [alias, setAlias] = React.useState('')
  const [note, setNote] = React.useState('')
  const [groupId, setGroupId] = React.useState<string | null>(null)
  const [tagIds, setTagIds] = React.useState<string[]>([])
  const [createTagOpen, setCreateTagOpen] = React.useState(false)
  const [formInitialized, setFormInitialized] = React.useState(false)

  // Sync state when device query updates
  const [lastSyncedDeviceId, setLastSyncedDeviceId] = React.useState<string | null>(null)
  if (device && (lastSyncedDeviceId !== device.id || !formInitialized)) {
    setLastSyncedDeviceId(device.id)
    setAlias(device.alias || '')
    setNote(device.note || '')
    setGroupId(device.group_id ?? null)
    setTagIds(device.tags.map((t) => t.id))
    setFormInitialized(true)
  }

  const connection = useDeviceConnect(deviceId)

  // Mutations
  const patchMutation = useMutation({
    mutationFn: (body: {
      alias?: string
      note?: string
      group_id?: string | null
      tag_ids?: string[]
    }) =>
      unwrap(
        api.PATCH('/admin/api/v1/devices/{id}', {
          params: { path: { id: deviceId } },
          body,
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.device(deviceId), updated)
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      toast({
        title: 'Device updated',
        description: 'Changes have been saved successfully.',
        variant: 'default',
      })
    },
    onError: (err) => {
      toast({
        title: 'Update failed',
        description: describeError(err).message,
        variant: 'destructive',
      })
    },
  })

  const approveDevices = useApproveDevices()
  const approveMutation = useMutation({
    meta: { errorTitle: 'Could not approve the device' },
    mutationFn: async () => {
      if (!device) throw new Error('Device is unavailable')
      const result = await approveDevices.approve([device])
      if (result.failed.length) throw result.failed[0]!.error
      return result.success[0]!.result
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.device(deviceId), updated)
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
    },
  })

  const rejectDevices = useRejectDevices()
  const rejectMutation = useMutation({
    meta: { errorTitle: 'Could not reject the device' },
    mutationFn: () => {
      if (!device) throw new Error('Device is unavailable')
      return rejectDevices.rejectOne(device)
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.device(deviceId), updated)
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
    },
  })

  const archiveMutation = useMutation({
    meta: { errorTitle: 'Could not archive the device' },
    mutationFn: () =>
      unwrap(
        api.POST('/admin/api/v1/devices/{id}/archive', { params: { path: { id: deviceId } } }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.device(deviceId), updated)
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
      toast({ title: 'Device archived' })
    },
  })

  const restoreMutation = useMutation({
    meta: { errorTitle: 'Could not restore the device' },
    mutationFn: () =>
      unwrap(
        api.POST('/admin/api/v1/devices/{id}/restore', { params: { path: { id: deviceId } } }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.device(deviceId), updated)
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
      toast({ title: 'Device restored' })
    },
  })

  const resolveAlertMutation = useMutation({
    meta: { errorTitle: 'Could not resolve the alert' },
    mutationFn: ({ alertId, action }: { alertId: string; action: 'accept_new_uuid' | 'dismiss' }) =>
      unwrap(
        api.POST('/admin/api/v1/devices/{id}/alerts/{alert_id}/resolve', {
          params: { path: { id: deviceId, alert_id: alertId } },
          body: { action },
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.device(deviceId), updated)
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
      toast({ title: 'Alert resolved' })
    },
  })

  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)

  const deleteMutation = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/admin/api/v1/devices/{id}', {
          params: { path: { id: deviceId } },
        }),
      ),
    onSuccess: () => {
      toast({ title: 'Device deleted' })
      setDeleteOpen(false)
      onClose?.()
      queryClient.removeQueries({ queryKey: queryKeys.device(deviceId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
    },
    onError: (err) => {
      setDeleteError(describeError(err).message)
    },
  })

  // Check dirtiness
  const isDirty = React.useMemo(() => {
    if (!device) return false
    const initialTags = new Set(device.tags.map((t) => t.id))
    const currentTags = new Set(tagIds)
    const tagsEqual =
      initialTags.size === currentTags.size && [...initialTags].every((id) => currentTags.has(id))
    return (
      alias !== (device.alias || '') ||
      note !== (device.note || '') ||
      groupId !== (device.group_id ?? null) ||
      !tagsEqual
    )
  }, [device, alias, note, groupId, tagIds])

  const handleSave = () => {
    patchMutation.mutate({
      alias: alias.trim() || undefined,
      note: note || undefined,
      group_id: groupId,
      tag_ids: tagIds,
    })
  }

  // Tag manipulation
  const handleRemoveTag = (tagIdToRemove: string) => {
    setTagIds((prev) => prev.filter((id) => id !== tagIdToRemove))
  }

  const handleAddTag = (tagIdToAdd: string) => {
    if (!tagIds.includes(tagIdToAdd)) {
      setTagIds((prev) => [...prev, tagIdToAdd])
    }
  }

  if (isLoading) {
    return (
      <div className={cn('p-6 space-y-6', className)} data-slot="device-detail-loading">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-8 w-20" />
        </div>
        <Skeleton className="h-24 w-full rounded-md" />
        <Skeleton className="h-48 w-full rounded-md" />
      </div>
    )
  }

  // Gone (deleted, here or elsewhere): say so even if it was shown before.
  // Any other failed refetch keeps the device on screen; only a failed first
  // load is an error.
  const gone = error instanceof ApiError && error.status === 404
  if (gone || isLoadingError || !device) {
    if (gone) {
      return (
        <div
          data-slot="device-detail-not-found"
          className={cn(
            'flex flex-col items-center justify-center gap-4 p-8 text-center',
            className,
          )}
        >
          <p className="text-sm text-muted-foreground">This device no longer exists.</p>
          {onClose && (
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      )
    }

    return (
      <div className={cn('p-6', className)}>
        <ErrorState error={error} retry={() => void refetch()} />
      </div>
    )
  }

  const availableTagsToAdd = tagsQuery.data?.filter((t) => !tagIds.includes(t.id)) ?? []

  return (
    <div
      data-slot="device-detail"
      data-device-id={device.id}
      className={cn('flex flex-col gap-6 p-6 overflow-y-auto', className)}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <StatusDot status={deviceStatus(device)} size="lg" />
            <h2 className="text-xl font-bold tracking-tight text-foreground">
              {deviceName(device)}
            </h2>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={!preferencesQuery.data || (!isPinned && isPinLimitReached)}
                  onClick={handleTogglePin}
                  aria-label={isPinned ? 'Unpin device' : 'Pin device'}
                >
                  <StarIcon
                    className={`size-4 ${
                      isPinned
                        ? 'text-status-pending fill-status-pending'
                        : 'text-muted-foreground hover:text-status-pending'
                    }`}
                  />
                </Button>
              </TooltipTrigger>
              {!isPinned && isPinLimitReached && (
                <TooltipContent>You can pin up to {PIN_LIMIT} devices.</TooltipContent>
              )}
            </Tooltip>
            <Badge
              variant={
                device.state === 'approved'
                  ? 'outline'
                  : device.state === 'pending'
                    ? 'pending'
                    : device.state === 'rejected'
                      ? 'alert'
                      : 'secondary'
              }
            >
              {device.state}
            </Badge>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>RustDesk ID:</span>
            <MonoId idText={device.rustdesk_id} />
          </div>
        </div>

        {/* State Transition Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {!readOnly && (
            <>
              {device.state === 'pending' && (
                <ApproveRejectActions
                  onApprove={() => approveMutation.mutate()}
                  onReject={() => rejectMutation.mutate()}
                  isApproving={approveMutation.isPending}
                  isRejecting={rejectMutation.isPending}
                  size="sm"
                />
              )}

              {device.state === 'rejected' && (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => approveMutation.mutate()}
                  disabled={approveMutation.isPending}
                >
                  Approve
                </Button>
              )}

              {device.state === 'approved' && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => archiveMutation.mutate()}
                  disabled={archiveMutation.isPending}
                >
                  Archive
                </Button>
              )}

              {device.state === 'archived' && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => restoreMutation.mutate()}
                  disabled={restoreMutation.isPending}
                >
                  Restore
                </Button>
              )}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDeleteError(null)
                  setDeleteOpen(true)
                }}
                className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 font-medium"
              >
                Delete
              </Button>
            </>
          )}

          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="Close device details"
              className="size-8 p-0"
            >
              <XIcon className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {device.state === 'approved' && (
        <DeviceConnectSection connection={connection} policyStatus={policyStatus} />
      )}

      {/* Policy Section */}
      {device.state === 'approved' && <DevicePolicySection deviceId={device.id} />}
      <DeviceIDAllowListSection
        deviceId={device.id}
        fromDeviceId={onClose ? device.id : undefined}
      />

      {/* Open Alerts Section */}
      {device.open_alerts && device.open_alerts.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-status-alert flex items-center gap-1.5">
            <AlertTriangleIcon className="size-4" />
            Open Alerts ({device.open_alerts.length})
          </h3>
          {device.open_alerts.map((alert) => (
            <div
              key={alert.id}
              data-slot="device-alert"
              className="flex flex-col gap-3 p-3 rounded-md border border-status-alert/30 bg-status-alert/10 text-xs"
            >
              {alert.kind === 'group_conflict' ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <div className="font-semibold text-foreground">Group Conflict</div>
                    <p className="text-muted-foreground">
                      This device matches rules for multiple groups:{' '}
                      <span className="font-medium text-foreground">
                        {alert.groups.map((g) => g.name).join(', ')}
                      </span>
                      .
                    </p>
                  </div>

                  {!readOnly && (
                    <div className="flex items-center gap-2 self-start sm:self-end">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          openGroupConflictDialog({ deviceId: device.id, initialDevice: device })
                        }
                      >
                        Resolve conflict…
                      </Button>
                    </div>
                  )}
                </>
              ) : alert.kind === 'access_window_unconfirmed' ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <div className="font-semibold text-foreground">
                      Access window not confirmed closed
                    </div>
                    <p className="text-muted-foreground">
                      Window closed at {formatAlertTime(alert.window_closed_at ?? alert.created_at)}
                      ; the device has not confirmed the baseline settings.
                    </p>
                  </div>

                  {!readOnly && (
                    <div className="flex items-center gap-2 self-start sm:self-end">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          resolveAlertMutation.mutate({
                            alertId: alert.id,
                            action: 'dismiss',
                          })
                        }
                        disabled={resolveAlertMutation.isPending}
                      >
                        Dismiss
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <div className="font-semibold text-foreground">Client UUID Mismatch</div>
                    <div className="flex flex-col sm:flex-row sm:items-baseline gap-x-4 gap-y-1 text-muted-foreground">
                      <div className="flex items-baseline gap-1.5 flex-wrap">
                        <span className="font-medium text-foreground">Pinned UUID:</span>
                        <span className="font-mono break-all">{device.uuid}</span>
                      </div>
                      <div className="flex items-baseline gap-1.5 flex-wrap">
                        <span className="font-medium text-foreground">New UUID:</span>
                        <span className="font-mono break-all">{alert.seen_uuid ?? ''}</span>
                        {alert.ip ? ` from ${alert.ip}` : ''}
                      </div>
                    </div>
                    <p className="text-muted-foreground mt-0.5">
                      The device was reinstalled or its identity changed; accepting trusts the new
                      UUID from now on; dismissing keeps the old one.
                    </p>
                  </div>

                  {!readOnly && (
                    <div className="flex items-center gap-2 self-start sm:self-end">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          resolveAlertMutation.mutate({
                            alertId: alert.id,
                            action: 'dismiss',
                          })
                        }
                        disabled={resolveAlertMutation.isPending}
                      >
                        Dismiss
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          resolveAlertMutation.mutate({
                            alertId: alert.id,
                            action: 'accept_new_uuid',
                          })
                        }
                        disabled={resolveAlertMutation.isPending}
                      >
                        Accept new uuid
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {readOnly ? (
        <div
          data-slot="device-metadata-readonly"
          className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
        >
          <h3 className="text-sm font-semibold text-foreground">Metadata</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-muted-foreground">Alias</span>
              <span className="font-medium text-foreground break-words">{device.alias || '—'}</span>
            </div>
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-muted-foreground">Group</span>
              <span className="font-medium text-foreground break-words">
                {(device.group_id && groupPathById.get(device.group_id)) || '—'}
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5 text-xs">
            <span className="text-muted-foreground">Tags</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {device.tags.length === 0 ? (
                <span className="text-muted-foreground">No tags applied</span>
              ) : (
                device.tags.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
                    style={{ backgroundColor: toCss(t.color), color: textColorFor(t.color) }}
                  >
                    {t.name}
                  </span>
                ))
              )}
            </div>
          </div>
          <div className="flex flex-col gap-0.5 text-xs">
            <span className="text-muted-foreground">Note</span>
            <span className="whitespace-pre-wrap break-words text-foreground">
              {device.note || '—'}
            </span>
          </div>
        </div>
      ) : (
        <>
          {/* Editable Metadata Form */}
          <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Metadata</h3>
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={!isDirty || patchMutation.isPending}
                className="gap-1.5"
              >
                <CheckIcon className="size-3.5" />
                {patchMutation.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Alias */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="device-alias" className="text-xs font-medium text-muted-foreground">
                  Alias (max 128)
                </label>
                <Input
                  id="device-alias"
                  value={alias}
                  maxLength={128}
                  onChange={(e) => setAlias(e.target.value)}
                  placeholder="e.g. Reception PC"
                  className="text-xs"
                />
              </div>

              {/* Group */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="device-group" className="text-xs font-medium text-muted-foreground">
                  Group
                </label>
                <GroupPicker
                  id="device-group"
                  groups={groupTree}
                  value={groupId}
                  onChange={setGroupId}
                  noneLabel="No group"
                />
              </div>
            </div>

            {/* Tags Picker */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-muted-foreground">Tags</label>
              <div className="flex flex-wrap items-center gap-1.5 min-h-[32px] p-2 rounded-md border border-input bg-surface-2">
                {tagIds.length === 0 ? (
                  <span className="text-xs text-muted-foreground">No tags applied</span>
                ) : (
                  tagIds.map((tid) => {
                    const tagObj =
                      device.tags.find((t) => t.id === tid) ||
                      tagsQuery.data?.find((t) => t.id === tid)
                    const name = tagObj?.name ?? tid
                    const color = tagObj?.color ?? 0
                    return (
                      <span
                        key={tid}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium"
                        style={{
                          backgroundColor: toCss(color),
                          color: textColorFor(color),
                        }}
                      >
                        {name}
                        <button
                          type="button"
                          aria-label={`Remove tag ${name}`}
                          onClick={() => handleRemoveTag(tid)}
                          className="hover:opacity-75 focus-visible:outline-hidden"
                        >
                          <XIcon className="size-3" />
                        </button>
                      </span>
                    )
                  })
                )}

                {/* Add tag dropdown */}
                {tagsQuery.data && (
                  <div className="ml-auto flex items-center gap-2">
                    <Select
                      value=""
                      onValueChange={(value) => {
                        if (value === '__create__') setCreateTagOpen(true)
                        else handleAddTag(value)
                      }}
                    >
                      <SelectTrigger
                        className="h-6 px-2 text-xs gap-1 border-dashed"
                        aria-label="Add tag"
                      >
                        <PlusIcon className="size-3" />
                        <span>Add tag</span>
                      </SelectTrigger>
                      <SelectContent align="end">
                        {availableTagsToAdd.map((t) => (
                          <SelectItem key={t.id} value={t.id} className="text-xs">
                            <span
                              className="inline-block size-2 rounded-full mr-1.5"
                              style={{ backgroundColor: toCss(t.color) }}
                            />
                            {t.name}
                          </SelectItem>
                        ))}
                        <SelectSeparator />
                        <SelectItem value="__create__" className="text-xs">
                          <PlusIcon className="size-3 mr-1.5" />
                          Create tag…
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <TagFormDialog
                      open={createTagOpen}
                      onOpenChange={setCreateTagOpen}
                      onCreated={(tag) => handleAddTag(tag.id)}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Note */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="device-note" className="text-xs font-medium text-muted-foreground">
                Note (max 4096)
              </label>
              <textarea
                id="device-note"
                rows={3}
                maxLength={4096}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Operational notes, location, or hardware details…"
                className="w-full rounded-md border border-input bg-background p-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
        </>
      )}

      {/* Hardware & System Specs (Read-Only) */}
      <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Hardware & System Specifications</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-muted-foreground">Hostname</span>
            <span className="font-medium text-foreground">{device.hostname || '—'}</span>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-muted-foreground">Pinned Client UUID</span>
            <MonoId idText={device.uuid} truncate className="break-all" />
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-muted-foreground">Operating System</span>
            <span className="font-medium text-foreground break-words">{device.os || '—'}</span>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-muted-foreground">Client Version</span>
            <span className="font-mono font-medium text-foreground">
              {device.client_version ? `v${device.client_version}` : '—'}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-muted-foreground">System User</span>
            <span className="font-medium text-foreground">{device.username || '—'}</span>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-muted-foreground">CPU</span>
            <span className="font-medium text-foreground break-words" title={device.cpu}>
              {device.cpu || '—'}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-muted-foreground">Memory</span>
            <span className="font-medium text-foreground">{device.memory || '—'}</span>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-muted-foreground">Online Status</span>
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <StatusDot status={device.online ? 'online' : 'offline'} size="sm" />
              <span>{device.online ? 'Online' : 'Offline'}</span>
            </div>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-muted-foreground">Heartbeat Active Connections</span>
            <span className="font-medium text-foreground">
              {device.conns.length > 0
                ? `${device.conns.length} (${device.conns.join(', ')})`
                : 'None'}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-muted-foreground">First Seen</span>
            <span className="text-foreground">
              <RelativeTime date={device.first_seen_at} />
            </span>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-muted-foreground">Last Heartbeat</span>
            <span className="text-foreground">
              <RelativeTime date={device.last_seen_at} />
            </span>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-muted-foreground">Approved At</span>
            <span className="text-foreground">
              {device.approved_at ? <RelativeTime date={device.approved_at} /> : '—'}
            </span>
          </div>
        </div>
      </div>

      <DeviceRecentSessions sessionsQuery={sessionsQuery} />

      <DeviceRecentAudit auditQuery={auditQuery} resolveActor={resolveActor} />

      {!readOnly && (
        <Dialog
          open={deleteOpen}
          onOpenChange={(open) => {
            if (!deleteMutation.isPending) {
              setDeleteOpen(open)
            }
          }}
        >
          <DialogContent data-slot="device-delete-dialog">
            <DialogHeader>
              <DialogTitle>Delete {deviceName(device)}?</DialogTitle>
              <DialogDescription>
                This removes the device, its tags, alerts and remote-session history from Ferricade.
                The audit log keeps a record. If its RustDesk client is still running with this
                server&apos;s settings, it will enroll again as a new pending device.
              </DialogDescription>
            </DialogHeader>

            {deleteError && (
              <p role="alert" className="text-xs text-destructive">
                {deleteError}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                autoFocus
                onClick={() => setDeleteOpen(false)}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete device'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
