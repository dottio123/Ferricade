import * as React from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

export interface MonoIdProps extends React.HTMLAttributes<HTMLElement> {
  idText: string
  truncate?: boolean
  copyable?: boolean
}

export function MonoId({
  idText,
  truncate = false,
  copyable = true,
  className,
  ...props
}: MonoIdProps) {
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'manual'>('idle')
  const inputRef = React.useRef<HTMLInputElement>(null)

  const handleCopy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (!copyable) return

    const result = await copyText(idText)
    if (result === 'copied') {
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 2000)
    } else {
      setCopyState('manual')
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus()
          inputRef.current.select()
        }
      }, 50)
      setTimeout(() => setCopyState('idle'), 4000)
    }
  }

  const displayText =
    truncate && idText.length > 12 ? `${idText.slice(0, 6)}…${idText.slice(-4)}` : idText

  const tooltipOpen = truncate ? (copyState !== 'idle' ? true : undefined) : copyState !== 'idle'

  if (copyable) {
    return (
      <Tooltip open={tooltipOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="mono-id"
            aria-label={`Copy ${idText}`}
            onClick={handleCopy}
            className={cn(
              'group inline-flex items-center gap-1.5 rounded-sm bg-muted/70 px-1.5 py-0.5 font-mono text-xs text-foreground transition-colors hover:bg-muted hover:text-primary-text focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring cursor-pointer',
              className,
            )}
            {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
          >
            <span>{displayText}</span>
            <span className="text-muted-foreground transition-colors group-hover:text-primary-text">
              {copyState === 'copied' ? (
                <CheckIcon className="size-3 text-status-online" />
              ) : (
                <CopyIcon className="size-3 opacity-60 group-hover:opacity-100" />
              )}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {copyState === 'copied' ? (
            <p className="font-mono text-xs">Copied!</p>
          ) : copyState === 'manual' ? (
            <div className="flex flex-col gap-1 py-0.5">
              <span className="text-xs font-medium text-status-pending">Press Ctrl+C to copy</span>
              <input
                ref={inputRef}
                readOnly
                value={idText}
                className="w-full rounded border border-border bg-surface-2 px-1 py-0.5 font-mono text-xs text-foreground select-all outline-hidden"
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
            </div>
          ) : (
            <p className="font-mono text-xs">{idText}</p>
          )}
        </TooltipContent>
      </Tooltip>
    )
  }

  const content = (
    <span
      data-slot="mono-id"
      className={cn(
        'inline-flex items-center rounded-sm bg-muted/70 px-1.5 py-0.5 font-mono text-xs text-foreground',
        className,
      )}
      {...props}
    >
      {displayText}
    </span>
  )

  if (truncate) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top">
          <p className="font-mono text-xs">{idText}</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  return content
}
