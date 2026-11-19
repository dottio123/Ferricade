import type { components } from '@/api/schema'
import { AlertTriangleIcon, CheckCircle2Icon, Loader2Icon, XCircleIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { checkHint } from './check-hint'

export type Check = components['schemas']['Check']

export interface ServerChecksProps {
  checks?: Check[] | null
  isRunning?: boolean
  className?: string
}

function checkLabel(name: string): string {
  switch (name) {
    case 'id-server':
      return 'ID Server (port 21116)'
    case 'relay':
      return 'Relay Server (port 21117)'
    case 'client-api':
      return 'Client API (port 21114)'
    case 'hbbs-online-query':
      return 'HBBS Online Query'
    default:
      return name
  }
}

export function ServerChecks({ checks, isRunning, className }: ServerChecksProps) {
  if (isRunning) {
    return (
      <div
        data-slot="server-checks-running"
        className={cn(
          'flex items-center gap-2 rounded-lg border border-border bg-surface-1 p-3 text-xs text-muted-foreground',
          className,
        )}
      >
        <Loader2Icon className="size-4 animate-spin text-primary" />
        <span>Testing server reachability…</span>
      </div>
    )
  }

  if (!checks || checks.length === 0) return null

  return (
    <div
      data-slot="server-checks"
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-3',
        className,
      )}
    >
      <span className="text-xs font-medium text-muted-foreground">Reachability check results:</span>
      <div className="flex flex-col gap-2">
        {checks.map((chk) => (
          <div
            key={chk.name}
            data-slot="server-check-row"
            className="flex flex-col gap-0.5 rounded border border-border/50 bg-background/50 p-2 text-xs"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono font-medium">{checkLabel(chk.name)}</span>
              <span
                className={cn(
                  'flex items-center gap-1 font-medium',
                  chk.ok ? 'text-status-online' : 'text-destructive',
                )}
              >
                {chk.ok ? (
                  <>
                    <CheckCircle2Icon className="size-3.5" />
                    <span>Passing</span>
                  </>
                ) : (
                  <>
                    <XCircleIcon className="size-3.5" />
                    <span>Failed</span>
                  </>
                )}
              </span>
            </div>
            {chk.ok ? (
              chk.address && (
                <p className="text-xs text-muted-foreground">
                  → <span className="font-mono break-all">{chk.address}</span>
                </p>
              )
            ) : (
              <div className="space-y-1 text-xs text-muted-foreground">
                <p className="break-all font-mono">
                  {chk.target}
                  {chk.address ? ` → ${chk.address}` : ''}
                </p>
                {checkHint(chk.reason, chk.address, chk.target) && (
                  <p>{checkHint(chk.reason, chk.address, chk.target)}</p>
                )}
                {chk.detail && <CheckDetails detail={chk.detail} />}
              </div>
            )}
          </div>
        ))}
      </div>

      {checks.some((c) => !c.ok) && (
        <div className="mt-1 flex items-start gap-2 rounded-md bg-status-pending/10 p-2.5 text-xs text-status-pending">
          <AlertTriangleIcon className="size-4 shrink-0 mt-0.5" />
          <span>Some reachability checks failed. Client connectivity may be limited.</span>
        </div>
      )}
    </div>
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
      {expanded && <pre className="break-all font-mono text-destructive">{detail}</pre>}
    </div>
  )
}
