import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface ApproveRejectActionsProps {
  onApprove: () => void
  onReject: () => void
  isApproving?: boolean
  isRejecting?: boolean
  disabled?: boolean
  size?: 'sm' | 'default'
  approveLabel?: string
  rejectLabel?: string
  approveAriaLabel?: string
  rejectAriaLabel?: string
  className?: string
  layout?: 'row' | 'card' | 'panel'
}

export function ApproveRejectActions({
  onApprove,
  onReject,
  isApproving = false,
  isRejecting = false,
  disabled = false,
  size = 'sm',
  approveLabel = 'Approve',
  rejectLabel = 'Reject',
  approveAriaLabel,
  rejectAriaLabel,
  className,
  layout = 'row',
}: ApproveRejectActionsProps) {
  const isBusy = isApproving || isRejecting || disabled

  return (
    <div
      className={cn(
        'flex items-center gap-2',
        layout === 'card' && 'w-full grid grid-cols-2',
        className,
      )}
    >
      {/* Reject first (quiet destructive: muted at rest, red hover) */}
      <Button
        type="button"
        variant="ghost"
        size={size}
        onClick={(e) => {
          e.stopPropagation()
          onReject()
        }}
        disabled={isBusy}
        aria-label={rejectAriaLabel ?? rejectLabel}
        className={cn(
          'text-muted-foreground hover:text-destructive hover:bg-destructive/10 font-medium transition-colors',
          layout === 'card' && 'w-full',
          size === 'sm' && 'h-7 px-2.5 text-xs',
        )}
      >
        {isRejecting ? 'Rejecting…' : rejectLabel}
      </Button>

      {/* Approve on right (primary action in words) */}
      <Button
        type="button"
        variant="default"
        size={size}
        onClick={(e) => {
          e.stopPropagation()
          onApprove()
        }}
        disabled={isBusy}
        aria-label={approveAriaLabel ?? approveLabel}
        className={cn(
          layout === 'card' && 'w-full',
          size === 'sm' && 'h-7 px-2.5 text-xs font-medium',
        )}
      >
        {isApproving ? 'Approving…' : approveLabel}
      </Button>
    </div>
  )
}
