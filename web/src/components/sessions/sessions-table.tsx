import * as React from 'react'
import { DeviceLink } from '@/components/devices/device-link'
import {
  CameraIcon,
  FolderSyncIcon,
  HelpCircleIcon,
  MonitorIcon,
  NetworkIcon,
  TerminalIcon,
} from 'lucide-react'
import type { components } from '@/api/schema'
import { MonoId } from '@/components/brand/mono-id'
import { RelativeTime } from '@/components/brand/relative-time'
import { StatusDot } from '@/components/brand/status-dot'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDuration, useSharedTicker } from '@/lib/ticker'
import { DISCONNECTED_LABEL, DisconnectSession } from './disconnect-session'

export type RemoteSession = components['schemas']['RemoteSession']

export interface SessionsTableProps {
  sessions: RemoteSession[]
  isLoading?: boolean
}

function SessionTypeBadge({ type }: { type: RemoteSession['type'] }) {
  switch (type) {
    case 'remote':
      return (
        <Badge variant="outline" className="gap-1 font-normal text-xs">
          <MonitorIcon className="size-3 text-primary-text" />
          Remote
        </Badge>
      )
    case 'file_transfer':
      return (
        <Badge variant="outline" className="gap-1 font-normal text-xs">
          <FolderSyncIcon className="size-3 text-chart-2" />
          File transfer
        </Badge>
      )
    case 'port_forward':
      return (
        <Badge variant="outline" className="gap-1 font-normal text-xs">
          <NetworkIcon className="size-3 text-chart-4" />
          Port forward
        </Badge>
      )
    case 'terminal':
      return (
        <Badge variant="outline" className="gap-1 font-normal text-xs">
          <TerminalIcon className="size-3 text-chart-3" />
          Terminal
        </Badge>
      )
    case 'camera':
      return (
        <Badge variant="outline" className="gap-1 font-normal text-xs">
          <CameraIcon className="size-3 text-chart-5" />
          Camera
        </Badge>
      )
    default:
      return (
        <Badge variant="secondary" className="gap-1 font-normal text-xs">
          <HelpCircleIcon className="size-3 text-muted-foreground" />
          Unknown
        </Badge>
      )
  }
}

function SessionStatusBadge({ session }: { session: RemoteSession }) {
  const isOpen = session.ended_at === null
  const isAttempt = session.authed_at === null
  const isStale = session.end_reason === 'stale'
  const isDisconnected = session.end_reason === 'disconnected'

  if (isOpen) {
    return (
      <Badge variant="online" className="gap-1.5 text-xs font-medium">
        <StatusDot status="online" size="sm" />
        Open
      </Badge>
    )
  }

  if (isAttempt) {
    return (
      <Badge variant="secondary" className="bg-muted text-muted-foreground font-normal text-xs">
        Attempt
      </Badge>
    )
  }

  if (isDisconnected) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="cursor-help text-xs font-normal">
            Disconnected
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="text-xs">{DISCONNECTED_LABEL}</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  if (isStale) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="cursor-help border-status-pending/30 text-status-pending bg-status-pending/15 text-xs font-normal"
          >
            Stale
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="text-xs">Client stopped reporting without clean close</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Badge variant="outline" className="text-muted-foreground border-border text-xs font-normal">
      Closed
    </Badge>
  )
}

function LiveDuration({ startedAt }: { startedAt: string }) {
  const now = useSharedTicker()
  const elapsed = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
  return <>{formatDuration(elapsed)}</>
}

const SessionRowItem = React.memo(function SessionRowItem({ session }: { session: RemoteSession }) {
  const isOpen = session.ended_at === null
  const isAttempt = session.authed_at === null

  // Calculate duration
  let durationText: string
  if (isAttempt && session.ended_at) {
    const elapsed = Math.max(
      0,
      Math.floor((Date.parse(session.ended_at) - Date.parse(session.started_at)) / 1000),
    )
    durationText = formatDuration(elapsed)
  } else {
    durationText = formatDuration(session.duration_seconds)
  }

  return (
    <TableRow
      data-slot="session-row"
      data-session-id={session.id}
      className={`grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 p-3.5 sm:p-0 sm:table-row hover:bg-muted/30 transition-colors ${
        isAttempt ? 'opacity-70 bg-muted/5' : ''
      }`}
    >
      {/* Device Column: Row 1 Left on phone */}
      <TableCell className="col-start-1 row-start-1 min-w-0 p-0 sm:px-4 sm:py-2.5 block sm:table-cell">
        <div className="flex flex-col min-w-0">
          <DeviceLink
            deviceId={session.device_id}
            className="text-xs font-semibold text-foreground hover:text-primary-text hover:underline truncate max-w-[200px]"
            title={session.device_name}
          >
            {session.device_name || 'Unnamed device'}
          </DeviceLink>
          {session.rustdesk_id && (
            <div className="mt-0.5">
              <MonoId idText={session.rustdesk_id} truncate />
            </div>
          )}
        </div>
      </TableCell>

      {/* Peer Column: Row 2 Full width on phone */}
      <TableCell className="col-span-2 col-start-1 row-start-2 min-w-0 p-0 sm:px-4 sm:py-2.5 block sm:table-cell">
        {isAttempt ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-col min-w-0 text-xs">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-muted-foreground sm:hidden shrink-0">Peer:</span>
              <span
                className="font-medium text-foreground truncate max-w-[180px]"
                title={session.peer_name || session.peer_rustdesk_id}
              >
                {session.peer_name || session.peer_rustdesk_id || '—'}
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              {session.peer_rustdesk_id && session.peer_name && (
                <MonoId
                  idText={session.peer_rustdesk_id}
                  truncate
                  className="shrink-0 whitespace-nowrap"
                />
              )}
              {session.client_ip && (
                <span className="text-xs font-mono text-muted-foreground">{session.client_ip}</span>
              )}
            </div>
          </div>
        )}
      </TableCell>

      {/* Type Column: hidden below md */}
      <TableCell className="py-2.5 hidden md:table-cell">
        <SessionTypeBadge type={session.type} />
      </TableCell>

      {/* Started Column: Row 3 Right on phone, hidden sm/md, table-cell lg+ */}
      <TableCell className="col-start-2 row-start-3 justify-self-end p-0 sm:px-4 sm:py-2.5 text-xs text-muted-foreground whitespace-nowrap block sm:hidden lg:table-cell">
        <RelativeTime date={session.started_at} />
      </TableCell>

      {/* Duration Column: Row 3 Left on phone */}
      <TableCell className="col-start-1 row-start-3 p-0 sm:px-4 sm:py-2.5 block sm:table-cell">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground sm:hidden">Duration:</span>
          <span
            className={`font-mono tabular-nums ${
              isOpen ? 'text-primary-text font-medium' : 'text-foreground'
            }`}
          >
            {isOpen ? <LiveDuration startedAt={session.started_at} /> : durationText}
          </span>
        </div>
      </TableCell>

      {/* Status Column: Row 1 Right on phone */}
      <TableCell className="col-start-2 row-start-1 justify-self-end shrink-0 p-0 sm:px-4 sm:py-2.5 block sm:table-cell sm:text-right">
        <div className="flex items-center justify-end gap-2">
          <DisconnectSession session={session} compact />
          <SessionStatusBadge session={session} />
        </div>
      </TableCell>
    </TableRow>
  )
})

export function SessionsTable({ sessions }: SessionsTableProps) {
  return (
    <div
      data-slot="sessions-table-wrapper"
      className="rounded-lg border border-border bg-card shadow-xs overflow-hidden sm:overflow-x-auto"
    >
      <Table className="block sm:table">
        <TableHeader className="hidden sm:table-header-group">
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="w-[220px] text-xs font-semibold text-foreground">
              Device
            </TableHead>
            <TableHead className="w-[200px] text-xs font-semibold text-foreground hidden sm:table-cell">
              Peer
            </TableHead>
            <TableHead className="w-[140px] text-xs font-semibold text-foreground hidden md:table-cell">
              Type
            </TableHead>
            <TableHead className="w-[140px] text-xs font-semibold text-foreground hidden lg:table-cell">
              Started
            </TableHead>
            <TableHead className="w-[120px] text-xs font-semibold text-foreground">
              Duration
            </TableHead>
            <TableHead className="w-[140px] text-xs font-semibold text-foreground text-right">
              Status
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="block sm:table-row-group divide-y divide-border/60 sm:divide-y">
          {sessions.map((session) => (
            <SessionRowItem key={session.id} session={session} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
