import { cn } from '@/lib/utils'
import type { DashboardModuleId, DashboardModuleSize } from './preferences'

export interface SizePickerProps {
  moduleId: DashboardModuleId
  size: DashboardModuleSize
  availableSizes: DashboardModuleSize[]
  onChangeSize: (size: DashboardModuleSize) => void
  disabled?: boolean
  className?: string
}

export function SizePicker({
  moduleId,
  size,
  availableSizes,
  onChangeSize,
  disabled = false,
  className,
}: SizePickerProps) {
  return (
    <div
      role="group"
      aria-label={`Size for ${moduleId}`}
      className={cn(
        'inline-flex items-center rounded-md border border-border bg-muted p-0.5',
        className,
      )}
    >
      {availableSizes.map((s) => {
        const isSelected = s === size
        const label = s === 'small' ? 'S' : s === 'medium' ? 'M' : 'L'
        return (
          <button
            key={s}
            type="button"
            aria-pressed={isSelected}
            aria-label={`${s} size`}
            disabled={isSelected || disabled}
            onClick={() => onChangeSize(s)}
            className={cn(
              'px-1.5 py-0.5 text-xs font-semibold rounded-xs transition-colors',
              isSelected
                ? 'bg-nav-active text-nav-active-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
              disabled && 'opacity-40 cursor-not-allowed',
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
