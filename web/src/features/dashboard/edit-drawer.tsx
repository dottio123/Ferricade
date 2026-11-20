import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import type {
  DashboardCatalog,
  DashboardModuleId,
  DashboardModuleSize,
  Preferences,
} from './preferences'
import { SizePicker } from './size-picker'
import { moduleTitles } from './module-titles'

export interface EditDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  catalog: DashboardCatalog
  stagedPreferences: Preferences
  onSelectPreset: (presetId: 'homelab' | 'business' | 'wall') => void
  onToggleModule: (id: DashboardModuleId, enabled: boolean) => void
  onChangeModuleSize: (id: DashboardModuleId, size: DashboardModuleSize) => void
  onResetDefault: () => void
  onSave: () => void
  onCancel: () => void
  isSaving?: boolean
}

export function EditDrawer({
  open,
  onOpenChange,
  catalog,
  stagedPreferences,
  onSelectPreset,
  onToggleModule,
  onChangeModuleSize,
  onResetDefault,
  onSave,
  onCancel,
  isSaving,
}: EditDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        returnFocusSelector="[data-slot='dashboard-drawer-trigger']"
        side="right"
        className="w-full sm:max-w-md flex flex-col justify-between overflow-y-auto"
      >
        <div className="flex flex-col gap-6">
          <SheetHeader>
            <SheetTitle>Customize dashboard</SheetTitle>
            <SheetDescription>
              Toggle modules on or off, apply layout presets, or drag modules directly on the grid
              to reorder.
            </SheetDescription>
          </SheetHeader>

          {/* Nothing changes while a save is on its way: it would be lost. */}
          <fieldset disabled={isSaving} className="contents">
            {/* Presets Section */}
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Presets
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-muted-foreground hover:text-foreground"
                  onClick={onResetDefault}
                >
                  Reset to default
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {catalog.presets.map((preset) => {
                  const isSelected = stagedPreferences.preset === preset.id
                  return (
                    <Button
                      key={preset.id}
                      type="button"
                      variant={isSelected ? 'default' : 'outline'}
                      size="sm"
                      className="h-9 text-xs"
                      onClick={() => onSelectPreset(preset.id as 'homelab' | 'business' | 'wall')}
                    >
                      {preset.name}
                    </Button>
                  )
                })}
              </div>
              {stagedPreferences.preset === 'custom' && (
                <p className="text-xs text-muted-foreground italic">Current layout: Custom</p>
              )}
            </div>

            {/* Modules Toggle List */}
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Modules ({stagedPreferences.modules.filter((m) => m.enabled).length} visible)
              </span>
              <div className="flex flex-col divide-y divide-border/50 rounded-md border border-border bg-card">
                {stagedPreferences.modules.map((m) => {
                  const availableSizes = catalog.modules
                    .find((cm) => cm.id === m.id)
                    ?.sizes.map((s) => s.name as DashboardModuleSize) ?? [m.size]
                  return (
                    <div
                      key={m.id}
                      className="flex items-center justify-between px-3 py-2.5 text-sm"
                    >
                      <div className="flex items-center gap-2 min-w-0 pr-2">
                        <span className="font-medium text-foreground truncate">
                          {moduleTitles[m.id]}
                        </span>
                      </div>
                      <div className="flex items-center gap-2.5 shrink-0">
                        <SizePicker
                          moduleId={m.id}
                          size={m.size}
                          availableSizes={availableSizes}
                          onChangeSize={(newSize) => onChangeModuleSize(m.id, newSize)}
                          disabled={!m.enabled}
                        />
                        <Switch
                          checked={m.enabled}
                          onCheckedChange={(checked) => onToggleModule(m.id, checked)}
                          aria-label={`Show ${moduleTitles[m.id]}`}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </fieldset>
        </div>

        <SheetFooter className="mt-8 flex flex-col-reverse sm:flex-row gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSaving}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={onSave}
            disabled={isSaving}
            className="w-full sm:w-auto"
          >
            {isSaving ? 'Saving...' : 'Save layout'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
