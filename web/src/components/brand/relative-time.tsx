import * as React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSharedTicker } from '@/lib/ticker'
import { cn } from '@/lib/utils'

export function formatRelativeTime(date: Date, now: number): string {
  if (now === 0) return ''
  const diffMs = now - date.getTime()
  // Treat differences under 60s either way as "just now" (server/browser clock skew)
  if (Math.abs(diffMs) < 60000) {
    return 'just now'
  }
  if (diffMs < 0) {
    return 'in the future'
  }
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  const diffMonths = Math.floor(diffDays / 30)
  if (diffMonths < 12) return `${diffMonths}mo ago`
  const diffYears = Math.floor(diffDays / 365)
  return `${diffYears}y ago`
}

export interface RelativeTimeProps extends React.HTMLAttributes<HTMLElement> {
  date: Date | string | number
}

export function RelativeTime({ date, className, ...props }: RelativeTimeProps) {
  const now = useSharedTicker(30000)
  const d = React.useMemo(() => (date instanceof Date ? date : new Date(date)), [date])

  if (Number.isNaN(d.getTime())) {
    return (
      <span data-slot="relative-time" className={cn('text-muted-foreground', className)} {...props}>
        —
      </span>
    )
  }

  const iso = d.toISOString()
  const exactLocal = d.toLocaleString()
  const relativeText = formatRelativeTime(d, now)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          data-slot="relative-time"
          dateTime={iso}
          tabIndex={0}
          className={cn(
            'cursor-help underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded-xs text-muted-foreground hover:text-foreground transition-colors',
            className,
          )}
          {...(props as React.HTMLAttributes<HTMLTimeElement>)}
        >
          {relativeText || exactLocal}
        </time>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="font-mono text-xs">{exactLocal}</p>
      </TooltipContent>
    </Tooltip>
  )
}
