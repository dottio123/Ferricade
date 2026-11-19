import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangleIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import { useRole } from '@/auth/role'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { queryKeys } from '@/lib/queryKeys'
import { cn } from '@/lib/utils'

export interface DevicePolicySectionProps {
  deviceId: string
  className?: string
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

function isToday(date: Date): boolean {
  const now = new Date()
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  )
}

function formatEndsAt(endsAt: string | null): string {
  if (endsAt === null) return 'Reachable until switched off'
  const d = new Date(endsAt)
  const time = formatTime(d)
  if (isToday(d)) {
    return `Reachable until ${time}`
  }
  const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `Reachable until ${time} (${dateStr})`
}

export function DevicePolicySection({ deviceId, className }: DevicePolicySectionProps) {
  const queryClient = useQueryClient()
  const role = useRole()
  const readOnly = role === 'user'

  const {
    data: status,
    isLoading,
    isLoadingError,
    error,
  } = useQuery({
    queryKey: queryKeys.devicePolicy(deviceId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/devices/{id}/policy', {
          params: { path: { id: deviceId } },
          signal,
        }),
      ),
  })

  // Open window form state
  const [showOpenForm, setShowOpenForm] = React.useState(false)
  const [durationValue, setDurationValue] = React.useState<string>('60')
  const [disconnectOnClose, setDisconnectOnClose] = React.useState(false)

  // Close window form state
  const [closeDisconnect, setCloseDisconnect] = React.useState(false)

  // Error message state
  const [actionError, setActionError] = React.useState<string | null>(null)

  const openMutation = useMutation({
    mutationFn: (body: { duration_minutes: 60 | 240 | 480 | null; disconnect_on_close: boolean }) =>
      unwrap(
        api.POST('/admin/api/v1/devices/{id}/access-window', {
          params: { path: { id: deviceId } },
          body,
        }),
      ),
    onSuccess: () => {
      setActionError(null)
      setShowOpenForm(false)
      void queryClient.invalidateQueries({ queryKey: queryKeys.devicePolicy(deviceId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.device(deviceId) })
    },
    onError: (err) => {
      setActionError(describeError(err).message)
    },
  })

  const closeMutation = useMutation({
    mutationFn: (body: { disconnect: boolean }) =>
      unwrap(
        api.POST('/admin/api/v1/devices/{id}/access-window/close', {
          params: { path: { id: deviceId } },
          body,
        }),
      ),
    onSuccess: () => {
      setActionError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.devicePolicy(deviceId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.device(deviceId) })
    },
    onError: (err) => {
      setActionError(describeError(err).message)
    },
  })

  const handleOpenWindow = () => {
    setActionError(null)
    const durationMinutes =
      durationValue === 'null' ? null : (parseInt(durationValue, 10) as 60 | 240 | 480)
    openMutation.mutate({
      duration_minutes: durationMinutes,
      disconnect_on_close: disconnectOnClose,
    })
  }

  const handleCloseWindow = () => {
    setActionError(null)
    closeMutation.mutate({
      disconnect: closeDisconnect,
    })
  }

  if (isLoading) {
    return (
      <div
        data-slot="device-policy-section"
        className={cn('flex flex-col gap-3 rounded-md border border-border bg-card p-4', className)}
      >
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>
    )
  }

  if (isLoadingError || !status) {
    return (
      <div
        data-slot="device-policy-section"
        className={cn('flex flex-col gap-2 rounded-md border border-border bg-card p-4', className)}
      >
        <h3 className="text-sm font-semibold text-foreground">Policy</h3>
        <p role="alert" className="text-xs text-destructive">
          Could not load policy: {describeError(error).message}
        </p>
      </div>
    )
  }

  const groupText = status.source_group ? ` (from group ${status.source_group.name})` : ''
  let statusSuffix = ''
  if (status.status === 'applied') {
    statusSuffix = ' · Applied'
  } else if (status.status === 'pending') {
    statusSuffix = ' · Pending'
  } else if (status.status === 'off') {
    statusSuffix = ' · Off. Policy push is off.'
  }

  const unconfirmedClosedAt = status.close_unconfirmed_since
    ? new Date(status.close_unconfirmed_since)
    : null

  return (
    <div
      data-slot="device-policy-section"
      className={cn('flex flex-col gap-3 rounded-md border border-border bg-card p-4', className)}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Policy</h3>
      </div>

      {/* Status line */}
      <p data-slot="policy-status-line" className="text-xs text-muted-foreground">
        Policy: {status.policy.name}
        {groupText}
        {statusSuffix}
      </p>

      {/* Always reachable replaces window controls */}
      {status.always_reachable ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground font-medium">
            Always reachable (policy allows password logins)
          </p>
          {!readOnly && (
            <p className="text-xs text-muted-foreground">
              Timed access is available when this device&apos;s policy refuses password logins.{' '}
              <Link
                to="/policies"
                search={{ edit: status.policy.id }}
                className="text-primary underline underline-offset-4 hover:underline"
              >
                Change the policy&apos;s baseline
              </Link>{' '}
              to use it.
            </p>
          )}
        </div>
      ) : status.window ? (
        /* Window open */
        <div className="flex flex-col gap-3 pt-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span
              data-slot="access-window-status"
              className="text-xs font-semibold text-status-online"
            >
              {formatEndsAt(status.window.ends_at)}
            </span>

            {!readOnly && (
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="close-disconnect"
                    checked={closeDisconnect}
                    onChange={(e) => setCloseDisconnect(e.target.checked)}
                    className="size-4 rounded border-input text-primary focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <label
                    htmlFor="close-disconnect"
                    className="text-xs text-foreground cursor-pointer select-none"
                  >
                    Also disconnect
                  </label>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCloseWindow}
                  disabled={closeMutation.isPending}
                >
                  {closeMutation.isPending ? 'Closing…' : 'Close now'}
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* No window */
        !readOnly &&
        status.push_enabled && (
          <div className="flex flex-col gap-2 pt-1">
            {!showOpenForm ? (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowOpenForm(true)}
                >
                  Allow access
                </Button>
              </div>
            ) : (
              <div
                data-slot="open-access-window-controls"
                className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-2 p-2.5"
              >
                <div className="flex items-center gap-1.5">
                  <label htmlFor="access-window-duration" className="sr-only">
                    Duration
                  </label>
                  <select
                    id="access-window-duration"
                    aria-label="Duration"
                    data-slot="access-window-duration"
                    value={durationValue}
                    onChange={(e) => setDurationValue(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="60">1 h</option>
                    <option value="240">4 h</option>
                    <option value="480">8 h</option>
                    <option value="null">Until switched off</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="disconnect-on-close"
                    checked={disconnectOnClose}
                    onChange={(e) => setDisconnectOnClose(e.target.checked)}
                    className="size-4 rounded border-input text-primary focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <label
                    htmlFor="disconnect-on-close"
                    className="text-xs text-foreground cursor-pointer select-none"
                  >
                    Also disconnect when it closes
                  </label>
                </div>

                <Button
                  type="button"
                  size="sm"
                  onClick={handleOpenWindow}
                  disabled={openMutation.isPending}
                >
                  {openMutation.isPending ? 'Opening…' : 'Open window'}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowOpenForm(false)}
                  disabled={openMutation.isPending}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )
      )}

      {/* Unconfirmed close warning */}
      {unconfirmedClosedAt && (
        <div
          data-slot="unconfirmed-close-warning"
          className="flex items-start gap-2.5 rounded-md border border-status-alert/30 bg-status-alert/10 p-3 text-xs text-foreground leading-relaxed mt-1"
        >
          <AlertTriangleIcon className="size-4 text-status-alert shrink-0 mt-0.5" />
          <span>
            Closing… not confirmed by the device since {formatTime(unconfirmedClosedAt)}. Until it
            confirms, it may still accept password logins.
            {status.status === 'off' &&
              ' Policy push is off, so the device cannot receive the closed settings.'}
          </span>
        </div>
      )}

      {/* Action error display */}
      {actionError && (
        <p role="alert" className="text-xs text-destructive font-medium">
          {actionError}
        </p>
      )}
    </div>
  )
}
