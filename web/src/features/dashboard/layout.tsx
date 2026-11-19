import * as React from 'react'
import { cn } from '@/lib/utils'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import {
  getModuleGridDimensions,
  type DashboardCatalog,
  type DashboardModuleId,
  type DashboardModuleSize,
  type Preferences,
} from './preferences'
import { SortableModule } from './sortable-module'

export interface DashboardLayoutProps {
  catalog: DashboardCatalog
  preferences: Preferences
  isEditMode: boolean
  renderModule: (id: DashboardModuleId, size: DashboardModuleSize) => React.ReactNode
  onReorder: (activeId: DashboardModuleId, overId: DashboardModuleId) => void
  onToggleModule: (id: DashboardModuleId, enabled: boolean) => void
  onChangeModuleSize?: (id: DashboardModuleId, size: DashboardModuleSize) => void
  isKioskMode?: boolean
  className?: string
}

export function DashboardLayout({
  catalog,
  preferences,
  isEditMode,
  renderModule,
  onReorder,
  onToggleModule,
  onChangeModuleSize,
  isKioskMode,
  className,
}: DashboardLayoutProps) {
  // Lookup map for module size from preferences
  const moduleSizes = React.useMemo(() => {
    const map = new Map<DashboardModuleId, DashboardModuleSize>()
    for (const m of preferences.modules) {
      map.set(m.id, m.size)
    }
    return map
  }, [preferences.modules])

  // Setup dnd-kit sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const [activeId, setActiveId] = React.useState<DashboardModuleId | null>(null)

  const [activeRect, setActiveRect] = React.useState<{ width: number; height: number } | null>(null)

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as DashboardModuleId)
    const el = document.querySelector<HTMLElement>(`[data-module-id="${event.active.id}"]`)
    if (el) {
      const rect = el.getBoundingClientRect()
      setActiveRect({ width: Math.round(rect.width), height: Math.round(rect.height) })
    } else {
      const rect = event.active.rect.current.initial
      if (rect) {
        setActiveRect({ width: Math.round(rect.width), height: Math.round(rect.height) })
      }
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      onReorder(active.id as DashboardModuleId, over.id as DashboardModuleId)
    }
    setActiveId(null)
    setActiveRect(null)
  }

  const handleDragCancel = () => {
    setActiveId(null)
    setActiveRect(null)
  }

  // Modules to render
  const visibleModules = React.useMemo(() => {
    if (isEditMode) {
      // In edit mode show enabled modules so user can reorder what is active
      return preferences.modules.filter((m) => m.enabled)
    }
    return preferences.modules.filter((m) => m.enabled)
  }, [isEditMode, preferences.modules])

  const visibleIds = React.useMemo(() => visibleModules.map((m) => m.id), [visibleModules])

  const handleMoveUp = (index: number) => {
    if (index > 0) {
      const activeId = visibleModules[index]!.id
      const overId = visibleModules[index - 1]!.id
      onReorder(activeId, overId)
    }
  }

  const handleMoveDown = (index: number) => {
    if (index < visibleModules.length - 1) {
      const activeId = visibleModules[index]!.id
      const overId = visibleModules[index + 1]!.id
      onReorder(activeId, overId)
    }
  }

  const isWall = preferences.preset === 'wall'

  if (!isEditMode) {
    return (
      <div
        data-slot="dashboard-grid"
        data-preset={isWall ? 'wall' : undefined}
        style={
          isWall
            ? ({
                '--wall-grid-height': isKioskMode
                  ? 'calc(100dvh - 2rem)'
                  : 'calc(100dvh - 12.5rem)',
              } as React.CSSProperties)
            : undefined
        }
        className={cn('dashboard-bento-grid', isWall && 'lg:flex-1 lg:min-h-0', className)}
      >
        {visibleModules.map((m) => {
          const size = moduleSizes.get(m.id) ?? 'medium'
          const dims = getModuleGridDimensions(catalog, m.id, size)
          return (
            <SortableModule
              key={m.id}
              id={m.id}
              size={size}
              cols={dims.cols}
              rows={dims.rows}
              isEditMode={false}
            >
              {renderModule(m.id, size)}
            </SortableModule>
          )
        })}
      </div>
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={visibleIds} strategy={rectSortingStrategy}>
        <div
          data-slot="dashboard-grid"
          data-preset={isWall ? 'wall' : undefined}
          className={cn(
            'dashboard-bento-grid',
            'dashboard-edit-canvas',
            isWall && 'lg:flex-1 lg:min-h-0',
            className,
          )}
        >
          {visibleModules.map((m, index) => {
            const size = moduleSizes.get(m.id) ?? 'medium'
            const dims = getModuleGridDimensions(catalog, m.id, size)
            const catMod = catalog.modules.find((cm) => cm.id === m.id)
            const availableSizes = catMod?.sizes.map((s) => s.name as DashboardModuleSize) ?? [size]
            return (
              <SortableModule
                key={m.id}
                id={m.id}
                size={size}
                availableSizes={availableSizes}
                cols={dims.cols}
                rows={dims.rows}
                isEditMode={isEditMode}
                canMoveUp={index > 0}
                canMoveDown={index < visibleModules.length - 1}
                onMoveUp={() => handleMoveUp(index)}
                onMoveDown={() => handleMoveDown(index)}
                onToggle={(enabled) => onToggleModule(m.id, enabled)}
                onChangeSize={(newSize) => onChangeModuleSize?.(m.id, newSize)}
              >
                {renderModule(m.id, size)}
              </SortableModule>
            )
          })}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeId ? (
          <div
            data-slot="drag-overlay"
            style={
              activeRect
                ? { width: `${activeRect.width}px`, height: `${activeRect.height}px` }
                : undefined
            }
            className="rounded-lg shadow-2xl ring-2 ring-primary bg-card overflow-hidden"
          >
            <div className="h-full w-full pointer-events-none select-none">
              {renderModule(activeId, moduleSizes.get(activeId) ?? 'medium')}
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
