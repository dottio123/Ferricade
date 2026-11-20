import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import { describeError } from '@/api/errors'
import { StatusDot } from '@/components/brand/status-dot'
import { DeviceLink } from '@/components/devices/device-link'
import { groupPaths } from '@/components/groups/group-tree-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { deviceName, deviceStatus } from '@/lib/device'
import { groupsQueryOptions } from '@/lib/queries'
import { queryKeys } from '@/lib/queryKeys'
import { XIcon } from 'lucide-react'

type EffectiveId = components['schemas']['DeviceIdAllowList']['effective'][number]
type Device = components['schemas']['Device']
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]{5,15}$/
const HOVER_DELAY_MS = 150
const CLOSE_DELAY_MS = 80
const HELP =
  'Only these RustDesk IDs can connect. IDs are self-reported, so this narrows who can try; keep passwords and approval on. Sent only while policy push is on.'

const STATE_BADGE: Record<
  Exclude<Device['state'], 'approved'>,
  { label: string; variant: 'pending' | 'alert' | 'secondary' }
> = {
  pending: { label: 'Pending', variant: 'pending' },
  rejected: { label: 'Rejected', variant: 'alert' },
  archived: { label: 'Archived', variant: 'secondary' },
}

interface IdAllowListEditorProps {
  title: string
  ids: string[]
  onSave?: (ids: string[]) => Promise<unknown>
  readOnly?: boolean
  effective?: EffectiveId[]
  /** Origin device UUID when rendered inside a device panel. */
  fromDeviceId?: string
}

function AllowedIdCard({
  id,
  open,
  anchorRef,
  cardId,
  onDeviceChange,
  onClose,
  onCardMouseEnter,
  onCardMouseLeave,
}: {
  id: string
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  cardId: string
  onDeviceChange: (device: Device | null) => void
  onClose: () => void
  onCardMouseEnter: () => void
  onCardMouseLeave: () => void
}) {
  const devicesQuery = useQuery({
    queryKey: queryKeys.devices.list({ q: id, limit: 50 }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/devices', {
          params: { query: { q: id, limit: 50 } },
          signal,
        }),
      ),
  })

  const matchedDevice =
    devicesQuery.data?.items.find((item) => item.rustdesk_id.toLowerCase() === id.toLowerCase()) ??
    null

  React.useEffect(() => {
    onDeviceChange(matchedDevice)
  }, [matchedDevice, onDeviceChange])

  const groupId = matchedDevice?.group_id ?? null
  const groupsQuery = useQuery({
    ...groupsQueryOptions,
    enabled: Boolean(groupId),
  })

  const groupName = React.useMemo(() => {
    if (!groupId || !groupsQuery.data) return null
    return groupPaths(groupsQuery.data.items).get(groupId) ?? null
  }, [groupsQuery.data, groupId])

  return (
    <Popover open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        id={cardId}
        side="top"
        align="start"
        sideOffset={6}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          onClose()
        }}
        onPointerDownOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) {
            event.preventDefault()
            return
          }
          onClose()
        }}
        onFocusOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) {
            event.preventDefault()
            return
          }
          onClose()
        }}
        onMouseEnter={onCardMouseEnter}
        onMouseLeave={onCardMouseLeave}
        className="w-auto min-w-48 max-w-72 p-3 text-xs"
      >
        {devicesQuery.isPending ? (
          <Skeleton aria-label="Loading device" className="h-4 w-36" />
        ) : devicesQuery.isError ? (
          <p className="text-destructive">Could not load this device.</p>
        ) : !matchedDevice ? (
          <p className="text-muted-foreground">No enrolled device with this ID.</p>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <StatusDot status={deviceStatus(matchedDevice)} size="sm" />
              <span className="truncate font-medium text-foreground">
                {deviceName(matchedDevice)}
              </span>
              {matchedDevice.state !== 'approved' && (
                <Badge
                  variant={STATE_BADGE[matchedDevice.state].variant}
                  className="ml-auto shrink-0 px-1.5 py-0 text-2xs"
                >
                  {STATE_BADGE[matchedDevice.state].label}
                </Badge>
              )}
            </div>
            {(matchedDevice.username || groupName) && (
              <div className="flex flex-col gap-0.5 text-muted-foreground">
                {matchedDevice.username && (
                  <div className="truncate">
                    User: <span className="text-foreground">{matchedDevice.username}</span>
                  </div>
                )}
                {groupName && (
                  <div className="truncate">
                    Group: <span className="text-foreground">{groupName}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function AllowedIdChip({ id, fromDeviceId }: { id: string; fromDeviceId?: string }) {
  const [open, setOpen] = React.useState(false)
  const [hasOpened, setHasOpened] = React.useState(false)
  const [matchedDevice, setMatchedDevice] = React.useState<Device | null>(null)
  const cardId = React.useId()
  const openTimerRef = React.useRef<number | null>(null)
  const closeTimerRef = React.useRef<number | null>(null)
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const isFocusedRef = React.useRef(false)
  const prevMatchedIdRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    return () => {
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    }
  }, [])

  // Preserve keyboard focus if a plain <span> upgrades to a <DeviceLink> while focused.
  React.useLayoutEffect(() => {
    const nextId = matchedDevice?.id ?? null
    const changed = prevMatchedIdRef.current !== nextId
    prevMatchedIdRef.current = nextId
    if (changed && isFocusedRef.current && triggerRef.current) {
      triggerRef.current.focus({ preventScroll: true })
    }
  }, [matchedDevice?.id])

  const clearTimers = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const scheduleOpen = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (open || openTimerRef.current !== null) return
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      setHasOpened(true)
      setOpen(true)
    }, HOVER_DELAY_MS)
  }

  const scheduleClose = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (!open || closeTimerRef.current !== null) return
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }

  const closeImmediately = React.useCallback(() => {
    clearTimers()
    setOpen(false)
  }, [])

  const setTriggerRef = (node: HTMLElement | null) => {
    triggerRef.current = node
  }

  const triggerEvents = {
    onMouseEnter: scheduleOpen,
    onMouseLeave: scheduleClose,
    onFocus: () => {
      isFocusedRef.current = true
      scheduleOpen()
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      // Swapping <span> -> <DeviceLink> moves focus in useLayoutEffect; ignore synthetic unmount blur.
      if (!event.currentTarget.isConnected) return
      isFocusedRef.current = false
      closeImmediately()
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape' && (open || openTimerRef.current !== null)) {
        event.preventDefault()
        event.stopPropagation()
        closeImmediately()
      }
    },
  }

  return (
    <>
      {matchedDevice ? (
        <DeviceLink
          ref={setTriggerRef}
          deviceId={matchedDevice.id}
          fromDeviceId={fromDeviceId}
          aria-describedby={open ? cardId : undefined}
          className="font-semibold"
          onClick={closeImmediately}
          {...triggerEvents}
        >
          {id}
        </DeviceLink>
      ) : (
        <span
          ref={setTriggerRef}
          tabIndex={0}
          aria-describedby={open ? cardId : undefined}
          className="rounded-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          {...triggerEvents}
        >
          {id}
        </span>
      )}
      {hasOpened && (
        <AllowedIdCard
          id={id}
          open={open}
          anchorRef={triggerRef}
          cardId={cardId}
          onDeviceChange={setMatchedDevice}
          onClose={closeImmediately}
          onCardMouseEnter={() => {
            if (closeTimerRef.current !== null) {
              window.clearTimeout(closeTimerRef.current)
              closeTimerRef.current = null
            }
          }}
          onCardMouseLeave={scheduleClose}
        />
      )}
    </>
  )
}

function effectiveSections(effective: EffectiveId[] | undefined) {
  const entries = effective ?? []
  const device = entries.filter((entry) => entry.source === 'device').map((entry) => entry.id)
  const groups = new Map<string, { heading: string; ids: string[] }>()
  for (const entry of entries) {
    if (entry.source !== 'group') continue
    const key = entry.group_id ?? entry.group_name ?? ''
    const section = groups.get(key) ?? { heading: 'Group ' + (entry.group_name ?? ''), ids: [] }
    section.ids.push(entry.id)
    groups.set(key, section)
  }
  const global = entries.filter((entry) => entry.source === 'global').map((entry) => entry.id)
  return [
    { key: 'device', heading: 'This device', ids: device },
    ...[...groups].map(([key, section]) => ({ key: 'group:' + key, ...section })),
    { key: 'global', heading: 'Global', ids: global },
  ].filter((section) => section.ids.length > 0)
}

export function IdAllowListEditor({
  title,
  ids,
  onSave,
  readOnly = false,
  effective,
  fromDeviceId,
}: IdAllowListEditorProps) {
  const [draft, setDraft] = React.useState(ids)
  const [value, setValue] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const errorId = React.useId()
  const { toast } = useToast()

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSearch(value.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [value])
  const devices = useQuery({
    queryKey: queryKeys.devices.list({ limit: 200, q: search }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/devices', { params: { query: { limit: 200, q: search } }, signal }),
      ),
    enabled: !readOnly && search.length > 0,
  })
  const suggestions = (devices.data?.items ?? []).filter(
    (device: Device) =>
      value.length > 0 &&
      !draft.some((id) => id.toLowerCase() === device.rustdesk_id.toLowerCase()) &&
      `${device.rustdesk_id} ${device.hostname}`.toLowerCase().includes(value.toLowerCase()),
  )

  const add = (raw: string) => {
    const id = raw.trim()
    if (!ID_PATTERN.test(id)) {
      setError('Use 6 to 16 letters, numbers, or underscores; start with a letter or number.')
      return
    }
    if (draft.some((item) => item.toLowerCase() === id.toLowerCase())) {
      setError('That ID is already on the list.')
      return
    }
    if (draft.length >= 200) {
      setError('A list can contain at most 200 IDs.')
      return
    }
    setDraft((current) => [...current, id])
    setValue('')
    setError(null)
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (readOnly || !onSave) return
    setSaving(true)
    setError(null)
    try {
      await onSave(draft)
      toast({ title: 'ID allow list saved' })
    } catch (err) {
      setError(describeError(err).message)
    } finally {
      setSaving(false)
    }
  }

  // Sections in reading order: this device, each group (as the API returns them), global.
  // An ID on several sources appears under each; that is the data.
  // Without effective data (the Settings page for Admins) the read-only view is the plain list.
  const sections = effective
    ? effectiveSections(effective)
    : [{ key: 'list', heading: null, ids: draft }].filter((section) => section.ids.length > 0)
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card p-4" aria-label={title}>
      <h3 className="min-w-0 break-words text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{HELP}</p>
      {readOnly ? (
        <div className="mt-3 flex min-w-0 flex-col gap-3">
          {sections.map(({ key, heading, ids: sectionIds }) => (
            <div key={key} className="min-w-0">
              {heading && (
                <h4 className="min-w-0 break-words text-xs font-medium text-muted-foreground">
                  {heading}
                </h4>
              )}
              <ul className="mt-1.5 flex min-w-0 flex-wrap gap-2" aria-label={heading ?? title}>
                {sectionIds.map((id) => (
                  <li key={id} className="min-w-0 max-w-full">
                    <Badge
                      variant="outline"
                      className="max-w-full whitespace-normal break-all font-mono"
                    >
                      <AllowedIdChip id={id} fromDeviceId={fromDeviceId} />
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {sections.length === 0 && <p className="text-xs text-muted-foreground">No IDs</p>}
        </div>
      ) : (
        <form onSubmit={save} className="mt-3 flex min-w-0 flex-col gap-3">
          <fieldset disabled={saving} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
            <ul className="flex min-w-0 flex-wrap gap-2" aria-label={`${title} entries`}>
              {draft.map((id) => (
                <li key={id}>
                  <Badge variant="secondary" className="gap-1 font-mono">
                    <AllowedIdChip id={id} fromDeviceId={fromDeviceId} />
                    <button
                      type="button"
                      aria-label={`Remove ${id}`}
                      className="rounded-sm hover:text-destructive focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setDraft((current) => current.filter((item) => item !== id))}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                aria-label="Add RustDesk ID"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    add(value)
                  }
                }}
                placeholder="RustDesk ID"
                maxLength={16}
              />
              <Button type="button" variant="outline" onClick={() => add(value)}>
                Add ID
              </Button>
            </div>
            {suggestions.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Enrolled device suggestions">
                {suggestions.slice(0, 8).map((device) => (
                  <li key={device.id} className="min-w-0 max-w-full">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto max-w-full whitespace-normal break-all px-2 py-1 text-left"
                      onClick={() => add(device.rustdesk_id)}
                    >
                      {device.hostname} ({device.rustdesk_id})
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {error && (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={saving} aria-label={`Save ${title}`}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  )
}
