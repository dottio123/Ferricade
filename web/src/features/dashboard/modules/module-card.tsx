import * as React from 'react'
import { describeError } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export interface ModuleCardProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string
  icon?: React.ReactNode
  badge?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  contentClassName?: string
}

export function ModuleCard({
  title,
  icon,
  badge,
  actions,
  children,
  className,
  contentClassName,
  ...props
}: ModuleCardProps) {
  return (
    <Card
      data-slot="dashboard-module-card"
      className={cn('flex h-full flex-col overflow-hidden shadow-xs border-border/80', className)}
      {...props}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-3 border-b border-border/40">
        <div className="flex items-center gap-2 min-w-0">
          {icon && <span className="text-muted-foreground shrink-0">{icon}</span>}
          <h2 data-slot="card-title" className="text-sm font-semibold tracking-tight truncate">
            {title}
          </h2>
          {badge}
        </div>
        {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
      </CardHeader>
      <CardContent className={cn('flex-1 p-4', contentClassName)}>{children}</CardContent>
    </Card>
  )
}

/**
 * Calm single-line empty state for modules with no items
 */
export function ModuleEmptyState({ message, className }: { message: string; className?: string }) {
  return (
    <div
      data-slot="module-empty-state"
      className={cn(
        'flex h-24 items-center justify-center text-center text-xs text-muted-foreground',
        className,
      )}
    >
      <p>{message}</p>
    </div>
  )
}

/**
 * A module whose data failed to load: never its empty message (which would
 * claim, say, that nothing needs attention). Compact, so it fits the
 * smallest module size.
 */
export function ModuleErrorState({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div
      role="alert"
      data-slot="module-error-state"
      className="flex h-full min-h-[48px] items-center justify-between gap-3 px-3 py-2 text-xs"
    >
      <p className="truncate text-muted-foreground min-w-0 flex-1">
        Could not load this: {describeError(error).message}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={retry}
        className="h-7 shrink-0 px-2.5 text-xs"
      >
        Try again
      </Button>
    </div>
  )
}
