import * as React from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ActivityIcon,
  CheckCircle2Icon,
  FolderTreeIcon,
  LayoutDashboardIcon,
  Loader2Icon,
  MonitorIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SunMoonIcon,
  TagsIcon,
  UsersIcon,
} from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import type { components } from '@/api/schema'
import { canVisit } from '@/auth/role'
import { useMe } from '@/auth/session'
import { StatusDot } from '@/components/brand/status-dot'
import { ServerChecks, type Check } from '@/components/server/server-checks'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { useThemeSwitch } from '@/features/appearance/use-theme-switch'
import { useConnectLink } from '@/hooks/use-connect-link'
import { queryKeys } from '@/lib/queryKeys'
import { summaryQueryOptions } from '@/lib/queries'
import { deviceName, deviceStatus } from '@/lib/device'
import { useApproveDevices } from '@/components/devices/use-approve-devices'

export type Device = components['schemas']['Device']

interface PaletteAction {
  id: string
  label: string
  hint: string | null
  icon: React.ComponentType<{ className?: string }>
  isLoading?: boolean
  badgeVariant?: 'pending'
}

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const approveDevices = useApproveDevices()
  const { toast } = useToast()
  const me = useMe().data
  const role = me?.user.role
  const isOwner = role === 'owner'
  // A User gets no entry for a page they cannot open or an action the server refuses.
  const isUser = role === 'user'

  const { cycleTheme } = useThemeSwitch()

  const [query, setQuery] = React.useState('')
  const [debouncedQuery, setDebouncedQuery] = React.useState('')
  const [showPendingConfirm, setShowPendingConfirm] = React.useState(false)
  const [isApprovingAll, setIsApprovingAll] = React.useState(false)
  const [serverChecks, setServerChecks] = React.useState<Check[] | null>(null)
  const [isRunningChecks, setIsRunningChecks] = React.useState(false)
  const {
    connect: connectLink,
    isLoading: isConnecting,
    error: connectError,
    clearError: clearConnectError,
  } = useConnectLink()

  // Track shift key on Enter and mouse clicks
  const lastEnterShiftRef = React.useRef(false)
  const isMouseClickRef = React.useRef(false)

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setQuery('')
        setDebouncedQuery('')
        setServerChecks(null)
        setIsRunningChecks(false)
        clearConnectError()
        lastEnterShiftRef.current = false
        isMouseClickRef.current = false
      } else {
        clearConnectError()
        lastEnterShiftRef.current = false
        isMouseClickRef.current = false
      }
      onOpenChange(nextOpen)
    },
    [clearConnectError, onOpenChange],
  )

  // Debounce search query 200ms
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim())
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  // Summary query for pending devices count
  const summaryQuery = useQuery(summaryQueryOptions)
  const pendingCount = summaryQuery.data?.devices.pending ?? 0

  // Devices search query: only once 2+ characters typed
  const devicesQuery = useQuery({
    queryKey: queryKeys.devices.list({ q: debouncedQuery, limit: 10 }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/devices', {
          params: { query: { q: debouncedQuery, limit: 10 } },
          signal,
        }),
      ),
    enabled: debouncedQuery.length >= 2,
  })

  const devices: Device[] = devicesQuery.data?.items ?? []
  const policyQueries = useQueries({
    queries: devices.map((device) => ({
      queryKey: queryKeys.devicePolicy(device.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        unwrap(
          api.GET('/admin/api/v1/devices/{id}/policy', {
            params: { path: { id: device.id } },
            signal,
          }),
        ),
      enabled: device.state === 'approved',
    })),
  })

  const handleDeviceAction = async (device: Device, isMouse: boolean, isShift: boolean) => {
    // If mouse click, Shift+Enter, or not approved: open device panel (safe action)
    if (isMouse || isShift || device.state !== 'approved') {
      handleOpenChange(false)
      void navigate({
        to: '.',
        search: ((prev: Record<string, unknown>) => ({ ...prev, device: device.id })) as never,
      })
    } else {
      // Plain Enter on approved device: connects
      const policy = queryClient.getQueryData<components['schemas']['DevicePolicyStatus']>(
        queryKeys.devicePolicy(device.id),
      )
      if (!policy || policy.connect === 'locked') return
      if (isConnecting) return
      clearConnectError()
      const res = await connectLink(device.id, { action: 'connect', relay: false })
      if (res) {
        handleOpenChange(false)
      } else {
        void queryClient.invalidateQueries({ queryKey: queryKeys.devicePolicy(device.id) })
        toast({
          title: 'Failed to connect',
          description: 'Failed to connect to device.',
          variant: 'destructive',
        })
      }
    }
  }

  const handlePageSelect = (path: string) => {
    lastEnterShiftRef.current = false
    isMouseClickRef.current = false
    handleOpenChange(false)
    void navigate({ to: path })
  }

  const handleActionSelect = (id: string) => {
    lastEnterShiftRef.current = false
    isMouseClickRef.current = false
    if (id === 'toggle-theme') {
      cycleTheme()
      handleOpenChange(false)
    } else if (id === 'server-checks') {
      setIsRunningChecks(true)
      unwrap(api.POST('/admin/api/v1/server/check'))
        .then((res) => {
          setServerChecks(res.checks)
        })
        .catch((err) => {
          toast({
            title: 'Server check failed',
            description: describeError(err).message,
            variant: 'destructive',
          })
        })
        .finally(() => {
          setIsRunningChecks(false)
        })
    } else if (id === 'approve-all') {
      if (pendingCount === 0) {
        toast({ title: 'No devices waiting for approval.' })
      } else {
        handleOpenChange(false)
        setShowPendingConfirm(true)
      }
    }
  }

  const handleConfirmApproveAll = async () => {
    setIsApprovingAll(true)
    try {
      // Load all pending devices across all pages
      let cursor: string | undefined = undefined
      const allPending: Device[] = []
      do {
        const queryCursor: string | undefined = cursor
        const pageData: { items: Device[]; next_cursor: string } = await unwrap(
          api.GET('/admin/api/v1/devices', {
            params: {
              query: {
                state: 'pending',
                limit: 200,
                ...(queryCursor ? { cursor: queryCursor } : {}),
              },
            },
          }),
        )
        allPending.push(...pageData.items)
        cursor = pageData.next_cursor || undefined
      } while (cursor)

      if (allPending.length === 0) {
        toast({ title: 'No pending devices found.' })
        setShowPendingConfirm(false)
        return
      }

      const { success, failed } = await approveDevices.approve(allPending)

      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })

      if (failed.length > 0) {
        toast({
          title: `Approved ${success.length} of ${allPending.length} devices (${failed.length} failed)`,
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: 'Failed to approve devices',
        description: describeError(err).message,
        variant: 'destructive',
      })
    } finally {
      setIsApprovingAll(false)
      setShowPendingConfirm(false)
    }
  }

  const pages = React.useMemo(
    () =>
      [
        { label: 'Command Center', to: '/', icon: LayoutDashboardIcon },
        { label: 'Devices', to: '/devices', icon: MonitorIcon },
        { label: 'Approval Queue', to: '/devices/queue', icon: ActivityIcon },
        { label: 'Sessions', to: '/sessions', icon: ScrollTextIcon },
        { label: 'Audit Log', to: '/audit', icon: ScrollTextIcon },
        { label: 'Groups', to: '/groups', icon: FolderTreeIcon },
        { label: 'Tags', to: '/tags', icon: TagsIcon },
        { label: 'Policies', to: '/policies', icon: ShieldCheckIcon },
        { label: 'System Settings', to: '/settings', icon: SettingsIcon },
        ...(isOwner ? [{ label: 'Users', to: '/settings/users', icon: UsersIcon }] : []),
      ].filter((p) => canVisit(role, p.to)),
    [isOwner, role],
  )

  const filteredPages = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pages
    return pages.filter((p) => p.label.toLowerCase().includes(q))
  }, [pages, query])

  const actions = React.useMemo((): PaletteAction[] => {
    const toggleTheme: PaletteAction = {
      id: 'toggle-theme',
      label: 'Toggle theme',
      hint: 'dark → light → system',
      icon: SunMoonIcon,
    }
    if (isUser) return [toggleTheme]
    return [
      toggleTheme,
      {
        id: 'server-checks',
        label: 'Run server checks',
        hint: null,
        icon: ActivityIcon,
        isLoading: isRunningChecks,
      },
      {
        id: 'approve-all',
        label: 'Approve all pending',
        hint: pendingCount > 0 ? String(pendingCount) : null,
        badgeVariant: 'pending' as const,
        icon: CheckCircle2Icon,
      },
    ]
  }, [isUser, isRunningChecks, pendingCount])

  const filteredActions = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter((a) => a.label.toLowerCase().includes(q))
  }, [actions, query])

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={handleOpenChange}
        shouldFilter={false}
        title="Command Palette"
        description="Search devices, navigate pages, and run actions"
      >
        <div
          data-slot="command-palette-container"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              lastEnterShiftRef.current = e.shiftKey
              isMouseClickRef.current = false
            } else {
              lastEnterShiftRef.current = false
              isMouseClickRef.current = false
            }
          }}
        >
          <CommandInput
            placeholder="Type a command or search devices…"
            value={query}
            onValueChange={(val) => {
              setQuery(val)
              clearConnectError()
            }}
          />
          {connectError && (
            <div
              data-slot="palette-connect-error"
              role="alert"
              className="p-3 bg-destructive/10 text-destructive text-xs border-b border-destructive/20 flex items-center justify-between"
            >
              <span>{connectError}</span>
            </div>
          )}
          <CommandList>
            {filteredActions.length === 0 &&
              filteredPages.length === 0 &&
              debouncedQuery.length < 2 && <CommandEmpty>No results found.</CommandEmpty>}

            {/* Devices Search Results */}
            {debouncedQuery.length >= 2 && (
              <CommandGroup heading="Devices">
                {devicesQuery.isLoading ? (
                  <CommandItem
                    disabled
                    className="flex items-center gap-2 p-3 text-xs text-muted-foreground pointer-events-none select-none data-[disabled=true]:opacity-100"
                  >
                    <Loader2Icon className="size-3.5 animate-spin" />
                    <span>Searching devices…</span>
                  </CommandItem>
                ) : devices.length === 0 ? (
                  <CommandItem
                    disabled
                    className="p-3 text-xs text-muted-foreground pointer-events-none select-none data-[disabled=true]:opacity-100"
                  >
                    <span>No devices match &ldquo;{debouncedQuery}&rdquo;</span>
                  </CommandItem>
                ) : (
                  devices.map((device: Device, index) => {
                    const isApproved = device.state === 'approved'
                    const policy = policyQueries[index]?.data
                    const locked = isApproved && policy?.connect === 'locked'
                    const note = locked
                      ? 'Locked by policy. Allow access first.'
                      : policy?.connect === 'attended'
                        ? 'Someone at the device must accept.'
                        : policy?.connect === 'window' && policy.status === 'pending'
                          ? 'Applying access…'
                          : null
                    return (
                      <CommandItem
                        key={device.id}
                        disabled={locked}
                        title={locked ? (note ?? undefined) : undefined}
                        data-device-id={device.id}
                        value={`device ${deviceName(device)} ${device.id}`}
                        onMouseDown={() => {
                          isMouseClickRef.current = true
                        }}
                        onSelect={() => {
                          const isMouse = isMouseClickRef.current
                          const isShift = lastEnterShiftRef.current
                          isMouseClickRef.current = false
                          lastEnterShiftRef.current = false
                          handleDeviceAction(device, isMouse, isShift)
                        }}
                        className="flex min-w-0 items-start justify-between gap-2"
                      >
                        <div className="flex min-w-0 flex-1 items-start gap-2">
                          <StatusDot status={deviceStatus(device)} size="sm" />
                          <div className="flex min-w-0 flex-1 flex-col">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="device-result-name min-w-[8ch] flex-1 truncate font-medium">
                                {deviceName(device)}
                              </span>
                              {device.hostname && device.alias && (
                                <span className="hidden shrink truncate text-xs text-muted-foreground sm:inline">
                                  ({device.hostname})
                                </span>
                              )}
                              <Badge
                                variant={
                                  device.state === 'approved'
                                    ? 'outline'
                                    : device.state === 'pending'
                                      ? 'pending'
                                      : 'secondary'
                                }
                                className="shrink-0 text-2xs py-0 px-1"
                              >
                                {device.state}
                              </Badge>
                            </div>
                            {locked && note && (
                              <span className="device-action-note truncate text-xs text-muted-foreground sm:hidden">
                                {note}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="device-action-hint hidden shrink-0 text-xs text-muted-foreground font-mono pointer-fine:sm:inline">
                          {note ??
                            (isApproved
                              ? 'Enter: Connect · Shift+Enter: Details'
                              : 'Enter: Details')}
                        </span>
                      </CommandItem>
                    )
                  })
                )}
              </CommandGroup>
            )}

            {debouncedQuery.length >= 2 && filteredActions.length > 0 && <CommandSeparator />}

            {/* Quick Actions */}
            {filteredActions.length > 0 && (
              <CommandGroup heading="Actions">
                {filteredActions.map((action) => {
                  const Icon = action.icon
                  return (
                    <CommandItem
                      key={action.id}
                      value={action.id}
                      onSelect={() => handleActionSelect(action.id)}
                    >
                      <Icon className="size-4 mr-2" />
                      <span>{action.label}</span>
                      {action.isLoading && (
                        <Loader2Icon className="size-3.5 animate-spin ml-auto" />
                      )}
                      {action.hint && !action.badgeVariant && (
                        <span className="ml-auto text-xs text-muted-foreground font-mono">
                          {action.hint}
                        </span>
                      )}
                      {action.badgeVariant && action.hint && (
                        <Badge
                          variant={action.badgeVariant}
                          className="ml-auto text-2xs py-0 px-1.5"
                        >
                          {action.hint}
                        </Badge>
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}

            {/* Server Checks Results Display */}
            {(serverChecks || isRunningChecks) && (
              <div className="p-3 border-t border-border">
                <ServerChecks checks={serverChecks} isRunning={isRunningChecks} />
              </div>
            )}

            {filteredActions.length > 0 && filteredPages.length > 0 && <CommandSeparator />}

            {/* Pages Navigation */}
            {filteredPages.length > 0 && (
              <CommandGroup heading="Pages">
                {filteredPages.map((p) => {
                  const Icon = p.icon
                  return (
                    <CommandItem
                      key={p.to}
                      value={`page ${p.label} ${p.to}`}
                      onSelect={() => handlePageSelect(p.to)}
                    >
                      <Icon className="size-4 mr-2" />
                      <span>{p.label}</span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}
          </CommandList>
        </div>
      </CommandDialog>

      {/* Confirmation Dialog for Approve All Pending */}
      <Dialog open={showPendingConfirm} onOpenChange={setShowPendingConfirm}>
        <DialogContent returnFocusSelector="[data-slot='search-trigger']">
          <DialogHeader>
            <DialogTitle>Approve all pending devices?</DialogTitle>
            <DialogDescription>
              This will approve all {pendingCount} device{pendingCount === 1 ? '' : 's'} currently
              waiting in the approval queue.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowPendingConfirm(false)}
              disabled={isApprovingAll}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              onClick={() => void handleConfirmApproveAll()}
              disabled={isApprovingAll}
            >
              {isApprovingAll
                ? 'Approving…'
                : `Approve ${pendingCount} device${pendingCount === 1 ? '' : 's'}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
