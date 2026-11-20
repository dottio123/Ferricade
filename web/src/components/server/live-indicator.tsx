import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api, unwrap } from '../../api/client'
import { describeError } from '../../api/errors'
import { useRole } from '../../auth/role'
import { queryKeys } from '../../lib/queryKeys'
import { cn } from '../../lib/utils'
import { checkHint } from './check-hint'
import { useLiveStatus, useLiveStatusSince } from '../../live/useLiveEvents'
import type { paths } from '../../api/schema'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

const CHECK_NAMES = {
  'id-server': 'ID server (hbbs)',
  relay: 'Relay (hbbr)',
  'client-api': 'Client API (Ferricade)',
  'hbbs-online-query': 'hbbs online query',
} as const

type LiveStatus = ReturnType<typeof useLiveStatus>
type ServerHealthStatus =
  paths['/admin/api/v1/server/health']['get']['responses'][200]['content']['application/json']['status']

export function useServerHealth() {
  return useQuery({
    queryKey: queryKeys.serverHealth(),
    queryFn: ({ signal }) => unwrap(api.GET('/admin/api/v1/server/health', { signal })),
    refetchInterval: 30_000,
    retry: false,
  })
}

export function connectionLabel(status: LiveStatus, healthStatus?: ServerHealthStatus): string {
  return status === 'offline'
    ? 'Server offline'
    : status === 'reconnecting'
      ? 'Reconnecting…'
      : healthStatus === 'degraded'
        ? 'RustDesk server issue'
        : 'Live'
}

function localTime(value: string | number): string {
  const date = new Date(value)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}, ${time}`
}

export function LiveIndicator() {
  const [open, setOpen] = useState(false)
  const status = useLiveStatus()
  const since = useLiveStatusSince()
  const role = useRole()
  const isStaff = role === 'owner' || role === 'admin'
  const queryClient = useQueryClient()
  const health = useServerHealth()
  const check = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/api/v1/server/check')),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.serverHealth() }),
  })
  const label = connectionLabel(status, health.data?.status)
  const dot =
    status === 'offline'
      ? 'bg-status-offline text-status-offline'
      : status === 'reconnecting' || health.data?.status === 'degraded'
        ? 'bg-status-pending text-status-pending'
        : 'bg-status-online text-status-online animate-status-pulse-loop'

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void health.refetch()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Connection status: ${label}`}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground shrink-0 rounded-sm cursor-pointer overflow-x-clip sm:overflow-x-visible focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span role="status" aria-live="polite" className="flex items-center gap-1.5">
            <span className={cn('size-2 rounded-full shrink-0', dot)} aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">{label}</span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] space-y-4 text-sm">
        <section aria-labelledby="ferricade-health-heading">
          <h2 id="ferricade-health-heading" className="font-semibold text-foreground">
            Ferricade
          </h2>
          <p className="mt-1 text-muted-foreground">
            {status === 'offline'
              ? `Server not answering since ${localTime(since)}. Check that Ferricade and its proxy are running.`
              : status === 'reconnecting'
                ? `Reconnecting since ${localTime(since)}: the live stream is down, the server still answers. Pages refresh every 15 s meanwhile.`
                : 'Live updates connected'}
          </p>
        </section>
        <section aria-labelledby="rustdesk-health-heading">
          <h2 id="rustdesk-health-heading" className="font-semibold text-foreground">
            RustDesk server
          </h2>
          {health.isError ? (
            <p className="mt-1 text-muted-foreground">RustDesk health unavailable</p>
          ) : health.data?.status === 'unknown' ? (
            <p className="mt-1 text-muted-foreground">
              Not checked yet (runs every minute once setup is complete)
            </p>
          ) : health.data ? (
            <>
              <ul className="mt-2 space-y-3">
                {health.data.checks.map((item) => (
                  <li key={item.name}>
                    <div className="flex items-center justify-between gap-2">
                      <span>{CHECK_NAMES[item.name]}</span>
                      <span className="flex items-center gap-1.5 text-xs">
                        <span
                          aria-hidden="true"
                          className={cn(
                            'size-2 rounded-full',
                            item.ok ? 'bg-status-online' : 'bg-status-alert',
                          )}
                        />
                        {item.ok ? 'OK' : 'Failing'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">since {localTime(item.since)}</p>
                    {isStaff &&
                      (item.ok ? (
                        item.address && (
                          <p className="text-xs text-muted-foreground">
                            → <span className="font-mono break-all">{item.address}</span>
                          </p>
                        )
                      ) : (
                        <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                          <p className="break-all font-mono">
                            {item.target}
                            {item.address ? ` → ${item.address}` : ''}
                          </p>
                          {checkHint(item.reason, item.address, item.target) && (
                            <p>{checkHint(item.reason, item.address, item.target)}</p>
                          )}
                          {item.detail && <CheckDetails detail={item.detail} />}
                        </div>
                      ))}
                  </li>
                ))}
              </ul>
              {health.data.checked_at && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Last checked {localTime(health.data.checked_at)}
                </p>
              )}
            </>
          ) : (
            <p className="mt-1 text-muted-foreground">Checking RustDesk health…</p>
          )}
          {role === 'user' ? (
            <p className="mt-3 text-xs text-muted-foreground">
              If this persists, tell an administrator.
            </p>
          ) : isStaff ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={check.isPending}
                onClick={() => check.mutate()}
              >
                Check now
              </Button>
              <Link
                to="/settings/server"
                className="text-xs text-primary-text underline-offset-4 hover:underline"
              >
                Server settings
              </Link>
              {check.isError && (
                <p role="alert" className="w-full text-xs text-destructive">
                  {describeError(check.error).message}
                </p>
              )}
            </div>
          ) : null}
        </section>
      </PopoverContent>
    </Popover>
  )
}

function CheckDetails({ detail }: { detail: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        className="underline underline-offset-2"
        onClick={() => setExpanded((value) => !value)}
      >
        Details
      </button>
      {expanded && (
        <pre className="mt-1 whitespace-pre-wrap break-words rounded-sm bg-muted p-2 text-xs font-mono">
          {detail}
        </pre>
      )}
    </div>
  )
}
