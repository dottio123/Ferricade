import * as React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDownIcon, ArrowUpIcon, EyeOffIcon, GripVerticalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { DashboardModuleId, DashboardModuleSize } from './preferences'
import { SizePicker } from './size-picker'

export interface SortableModuleProps {
  id: DashboardModuleId
  size: DashboardModuleSize
  availableSizes?: DashboardModuleSize[]
  cols: number
  rows: number
  isEditMode: boolean
  children: React.ReactNode
  onMoveUp?: () => void
  onMoveDown?: () => void
  onToggle?: (enabled: boolean) => void
  onChangeSize?: (size: DashboardModuleSize) => void
  canMoveUp?: boolean
  canMoveDown?: boolean
}

export function SortableModule({
  id,
  size,
  availableSizes,
  cols,
  rows,
  isEditMode,
  children,
  onMoveUp,
  onMoveDown,
  onToggle,
  onChangeSize,
  canMoveUp = true,
  canMoveDown = true,
}: SortableModuleProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !isEditMode,
    transition: {
      duration: 200,
      easing: 'ease',
    },
  })

  const style: React.CSSProperties = {
    gridColumn: `span ${cols}`,
    gridRow: `span ${rows}`,
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.35 : undefined,
  }

  if (!isEditMode) {
    return (
      <div
        data-module-id={id}
        data-cols={cols}
        data-rows={rows}
        style={{ gridColumn: `span ${cols}`, gridRow: `span ${rows}` }}
        className="min-w-0 h-full"
      >
        {children}
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-module-id={id}
      data-cols={cols}
      data-rows={rows}
      data-edit-mode="true"
      className={cn(
        'group relative min-w-0 h-full rounded-lg transition-shadow',
        isDragging && 'shadow-xl ring-2 ring-primary ring-offset-2',
      )}
    >
      {/* Dashed border outline in edit mode, positioned absolutely so it takes no content box space */}
      <div className="pointer-events-none absolute inset-0 rounded-lg border-2 border-dashed border-primary/40 group-hover:border-primary/80 transition-colors z-10" />

      {/* Top action bar in edit mode: overlay over the card header */}
      <div className="absolute top-1.5 inset-x-1.5 z-20 flex items-center justify-between gap-1.5 bg-card px-2 py-1 rounded-md border border-border shadow-xs text-xs">
        <div className="flex items-center gap-1 min-w-0">
          <button
            type="button"
            className="flex items-center justify-center p-1 rounded-sm text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing focus:outline-hidden focus:ring-1 focus:ring-ring shrink-0 touch-none"
            aria-label={`Drag to reorder ${id}`}
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon className="size-4" />
          </button>
          <span className="font-mono text-xs font-medium text-foreground tracking-tight truncate">
            {id}
          </span>
          <SizePicker
            moduleId={id}
            size={size}
            availableSizes={availableSizes ?? [size]}
            onChangeSize={onChangeSize ?? (() => {})}
          />
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={onMoveUp}
            disabled={!canMoveUp}
            aria-label={`Move ${id} up`}
            title="Move up"
          >
            <ArrowUpIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={onMoveDown}
            disabled={!canMoveDown}
            aria-label={`Move ${id} down`}
            title="Move down"
          >
            <ArrowDownIcon className="size-3.5" />
          </Button>
          {onToggle && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-destructive"
              onClick={() => onToggle(false)}
              aria-label={`Hide ${id}`}
              title="Hide module"
            >
              <EyeOffIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="h-full w-full pointer-events-none select-none">{children}</div>
    </div>
  )
}
