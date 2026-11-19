import * as React from 'react'
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

export interface CopyFieldProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string
  label?: string
  sensitive?: boolean
}

export function CopyField({
  value,
  label,
  sensitive = false,
  className,
  ...props
}: CopyFieldProps) {
  const [copiedState, setCopiedState] = React.useState<'idle' | 'copied' | 'press-ctrl-c'>('idle')
  const [revealed, setRevealed] = React.useState(!sensitive)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const handleCopy = async () => {
    const result = await copyText(value)
    if (result === 'copied') {
      setCopiedState('copied')
      setTimeout(() => setCopiedState('idle'), 2500)
    } else {
      // On manual fallback, reveal the actual text and select it for Ctrl+C
      setRevealed(true)
      setCopiedState('press-ctrl-c')
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus()
          inputRef.current.select()
        }
      }, 50)
      setTimeout(() => setCopiedState('idle'), 4000)
    }
  }

  const toggleReveal = () => {
    setRevealed((prev) => !prev)
  }

  const displayValue = revealed ? value : '•'.repeat(Math.min(Math.max(value.length, 8), 24))

  return (
    <div data-slot="copy-field" className={cn('flex flex-col gap-1', className)} {...props}>
      {label && <label className="text-xs font-medium text-muted-foreground">{label}</label>}
      <div className="relative flex items-center">
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={displayValue}
          autoComplete="off"
          spellCheck={false}
          aria-label={label ?? 'Copyable value'}
          className={cn(
            'h-[var(--control-height,2.25rem)] w-full rounded-md border border-input bg-surface-2 pl-3 font-mono text-xs text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring select-all',
            sensitive ? 'pr-28' : 'pr-20',
          )}
        />
        <div className="absolute right-1 flex items-center gap-1">
          {sensitive && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={toggleReveal}
              aria-label={revealed ? 'Hide value' : 'Show value'}
              className="h-7 px-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {revealed ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="h-7 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            {copiedState === 'copied' ? (
              <span className="flex items-center gap-1 text-status-online">
                <CheckIcon className="size-3.5" />
                Copied
              </span>
            ) : copiedState === 'press-ctrl-c' ? (
              <span className="text-xs text-status-pending">Press Ctrl+C</span>
            ) : (
              <span className="flex items-center gap-1">
                <CopyIcon className="size-3.5" />
                Copy
              </span>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
