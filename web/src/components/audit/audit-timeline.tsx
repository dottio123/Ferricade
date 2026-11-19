import { DeviceLink } from '@/components/devices/device-link'
import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon } from 'lucide-react'
import { RelativeTime } from '@/components/brand/relative-time'
import { Button } from '@/components/ui/button'
import { auditDeviceTarget, describeAudit, type AuditEvent } from '@/features/audit/describe'
import { useAuditDeviceNames } from '@/features/audit/use-device-names'
import { copyText } from '@/lib/clipboard'
import { auditTargetLabel } from './audit-target'
import type { User } from '@/features/audit/actor'

export interface AuditTimelineProps {
  events: AuditEvent[]
  resolveActor: (actorUserId: string | null, action?: string, actorIp?: string) => string
  isOwner: boolean
  compact?: boolean
  users?: User[]
}

function JsonDetailsBlock({ details }: { details: Record<string, unknown> }) {
  const [copied, setCopied] = React.useState(false)
  const jsonString = React.useMemo(() => JSON.stringify(details, null, 2), [details])

  const handleCopy = async () => {
    const res = await copyText(jsonString)
    if (res === 'copied') {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-2 border-t border-border/40 mt-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Event details (JSON)
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <CheckIcon className="size-3 text-status-online" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <CopyIcon className="size-3" />
              <span>Copy JSON</span>
            </>
          )}
        </Button>
      </div>
      <pre
        data-slot="audit-json-details"
        className="font-mono text-xs p-3 rounded-md bg-muted/60 overflow-x-auto text-foreground whitespace-pre leading-relaxed select-text"
      >
        {jsonString}
      </pre>
    </div>
  )
}

export function AuditTimeline(props: AuditTimelineProps) {
  if (!props.compact) return <FullAuditTimeline {...props} />
  const { events, resolveActor } = props
  return (
    <ul className="flex flex-col divide-y divide-border/50">
      {events.map((a) => {
        const actorDisplay = resolveActor(a.actor_user_id, a.action, a.actor_ip)
        const described = describeAudit(a)
        return (
          <li key={a.id} data-slot="device-audit-entry" className="flex flex-col gap-0.5 py-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span
                data-slot="device-audit-action"
                className="min-w-0 break-words text-xs text-foreground"
              >
                {described.text}
                {described.suffix}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                <RelativeTime date={a.at} />
              </span>
            </div>
            <span
              data-slot="device-audit-actor"
              className="break-words text-xs text-muted-foreground"
            >
              {actorDisplay}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function FullAuditTimeline({ events, resolveActor, isOwner, users = [] }: AuditTimelineProps) {
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set())

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const deviceNameMap = useAuditDeviceNames(events)

  return (
    <div
      data-slot="audit-timeline"
      className="flex flex-col divide-y divide-border/50 rounded-lg border border-border bg-card shadow-xs overflow-hidden"
    >
      {events.map((event) => {
        const described = describeAudit(event)
        const targetLabel = auditTargetLabel(event, users)
        const targetText =
          targetLabel && described.text.endsWith(`"${targetLabel}"`)
            ? described.text.slice(0, -targetLabel.length - 2).trimEnd()
            : described.text
        const isFailedLogin = event.action === 'auth.login_failed'
        const isExpanded = expandedIds.has(event.id)
        const details = (event.details ?? {}) as Record<string, unknown> & {
          rustdesk_id?: string
        }

        const targetDeviceId = auditDeviceTarget(event, described)
        const deviceName = targetDeviceId
          ? deviceNameMap.get(targetDeviceId) || details.rustdesk_id || targetDeviceId.slice(0, 8)
          : undefined

        return (
          <div
            key={event.id}
            data-slot="audit-event-item"
            data-event-id={event.id}
            data-action={event.action}
            className={`flex flex-col p-4 transition-colors ${
              isFailedLogin ? 'bg-destructive/5' : 'hover:bg-muted/20'
            }`}
          >
            <div className="flex items-start justify-between gap-2 sm:gap-4">
              {/* Left side: Icon + Content */}
              <div className="flex items-start gap-2.5 sm:gap-3 min-w-0 flex-1">
                {isFailedLogin ? (
                  <AlertCircleIcon className="size-4 text-destructive shrink-0 mt-0.5" />
                ) : (
                  <div className="size-2 rounded-full bg-primary shrink-0 mt-2" />
                )}

                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <div className="text-sm leading-snug text-foreground break-words">
                    <span className="font-semibold text-foreground">
                      {resolveActor(event.actor_user_id, event.action, event.actor_ip)}
                    </span>{' '}
                    <span>{targetText}</span>
                    {/* Target Link Rendering */}
                    {targetDeviceId && (
                      <>
                        {' '}
                        <DeviceLink
                          deviceId={targetDeviceId}
                          className="font-medium text-foreground underline decoration-border/60 hover:text-primary"
                        >
                          {deviceName}
                        </DeviceLink>
                      </>
                    )}
                    {event.target_type === 'group' && targetLabel && (
                      <>
                        {' '}
                        <Link
                          to="/groups"
                          className="font-medium text-foreground underline decoration-border/60 hover:text-primary"
                        >
                          {targetLabel}
                        </Link>
                      </>
                    )}
                    {event.target_type === 'tag' && targetLabel && (
                      <>
                        {' '}
                        <Link
                          to="/tags"
                          className="font-medium text-foreground underline decoration-border/60 hover:text-primary"
                        >
                          {targetLabel}
                        </Link>
                      </>
                    )}
                    {event.target_type === 'user' &&
                      targetLabel &&
                      (isOwner ? (
                        <>
                          {' '}
                          <Link
                            to="/settings/users"
                            className="font-medium text-foreground underline decoration-border/60 hover:text-primary"
                          >
                            {targetLabel}
                          </Link>
                        </>
                      ) : null)}
                    {described.suffix}
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-2 text-xs text-muted-foreground min-w-0">
                    <span className="font-mono">from {event.actor_ip}</span>
                    <span className="hidden sm:inline" aria-hidden="true">
                      •
                    </span>
                    <span className="font-mono text-xs text-muted-foreground break-all [overflow-wrap:anywhere]">
                      {event.action}
                    </span>
                  </div>
                </div>
              </div>

              {/* Right side: Time + Expand Details Button */}
              <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
                <div className="text-xs text-muted-foreground whitespace-nowrap">
                  <RelativeTime date={event.at} />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 h-11 w-11 sm:h-7 sm:w-7 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
                  onClick={() => toggleExpand(event.id)}
                  aria-label={isExpanded ? 'Hide details' : 'Show details'}
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? (
                    <ChevronUpIcon className="size-4" />
                  ) : (
                    <ChevronDownIcon className="size-4" />
                  )}
                </Button>
              </div>
            </div>

            {/* Expandable JSON details panel */}
            {isExpanded && <JsonDetailsBlock details={details} />}
          </div>
        )
      })}
    </div>
  )
}
