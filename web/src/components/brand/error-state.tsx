import * as React from 'react'
import { AlertCircleIcon, RotateCcwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { describeError, type ErrorDescription } from '@/api/errors'
import { MonoId } from './mono-id'
import { cn } from '@/lib/utils'

export interface ErrorStateProps extends React.HTMLAttributes<HTMLDivElement> {
  error: ErrorDescription | unknown
  retry?: () => void
  title?: string
}

export function ErrorState({
  error,
  retry,
  title = 'Unable to load data',
  className,
  ...props
}: ErrorStateProps) {
  const desc: ErrorDescription =
    typeof error === 'object' && error !== null && 'code' in error && 'message' in error
      ? (error as ErrorDescription)
      : describeError(error)

  return (
    <div
      role="alert"
      data-slot="error-state"
      className={cn(
        'flex min-h-[160px] flex-col items-center justify-center rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center animate-in fade-in-50',
        className,
      )}
      {...props}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive mb-3">
        <AlertCircleIcon className="size-5" />
      </div>
      <h3 className="text-sm font-semibold text-foreground tracking-tight">{title}</h3>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground leading-relaxed">{desc.message}</p>
      {desc.requestId && (
        <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <span>Request:</span>
          <MonoId idText={desc.requestId} truncate />
        </div>
      )}
      {retry && (
        <div className="mt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={retry}
            className="h-8 gap-1.5 text-xs border-destructive/20 hover:bg-destructive/10 hover:text-destructive"
          >
            <RotateCcwIcon className="size-3.5" />
            <span>Try again</span>
          </Button>
        </div>
      )}
    </div>
  )
}
