import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRole } from '@/auth/role'
import { EmptyState } from '@/components/brand/empty-state'
import { ErrorState } from '@/components/brand/error-state'
import {
  CheckIcon,
  LayoutGridIcon,
  Maximize2Icon,
  SlidersHorizontalIcon,
  XIcon,
} from 'lucide-react'
import { Link, useSearch } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { summaryQueryOptions } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { EditDrawer } from './edit-drawer'
import { DashboardLayout } from './layout'
import { ActivityTrendModule } from './modules/activity-trend'
import { AdminActivityModule } from './modules/admin-activity'
import { ApprovalQueueModule } from './modules/approval-queue'
import { FleetOverviewModule } from './modules/fleet-overview'
import { FleetPulseModule } from './modules/fleet-pulse'
import { LiveSessionsModule } from './modules/live-sessions'
import { NeedsAttentionModule } from './modules/needs-attention'
import { PlatformMixModule } from './modules/platform-mix'
import { QuickConnectModule } from './modules/quick-connect'
import { RecentSessionsModule } from './modules/recent-sessions'
import { SessionAnalyticsModule } from './modules/session-analytics'
import {
  applyPreset,
  changeModuleSize,
  moveModule,
  toggleModule,
  type DashboardModuleId,
  type DashboardModuleSize,
  type Preferences,
} from './preferences'
import { useDashboardPreferences, useUpdatePreferences } from './use-preferences'

export function CommandCenter() {
  const { catalog, preferences, isLoading, isLoadingError, error, refetch } =
    useDashboardPreferences()
  const { saveWithUndo, isPending: isSaving } = useUpdatePreferences()
  // A User sees the scoped catalog's modules, and no wall display or kiosk.
  const isUser = useRole() === 'user'
  // With no devices assigned there is nothing to show: say so instead of empty modules.
  const summary = useQuery({ ...summaryQueryOptions, enabled: isUser })
  const hasNoDevices = isUser && summary.data !== undefined && summary.data.devices.approved === 0

  const [isEditMode, setIsEditMode] = React.useState(false)
  const [stagedPreferences, setStagedPreferences] = React.useState<Preferences | null>(null)
  const [isDrawerOpen, setIsDrawerOpen] = React.useState(false)

  // Current active preferences (staged while editing, otherwise saved)
  const activePreferences = isEditMode && stagedPreferences ? stagedPreferences : preferences

  const handleStartEdit = () => {
    if (preferences) {
      setStagedPreferences(structuredClone(preferences))
      setIsEditMode(true)
      setIsDrawerOpen(true)
    }
  }

  const handleCancelEdit = () => {
    setIsEditMode(false)
    setStagedPreferences(null)
    setIsDrawerOpen(false)
  }

  const handleSave = () => {
    if (stagedPreferences && preferences) {
      // Leave edit mode only once saved: a failed save keeps the edits (its
      // error is a toast, via the mutation's errorTitle).
      saveWithUndo(stagedPreferences, preferences, () => {
        setIsEditMode(false)
        setStagedPreferences(null)
        setIsDrawerOpen(false)
      })
    }
  }

  const handleReorder = (activeId: DashboardModuleId, overId: DashboardModuleId) => {
    if (!stagedPreferences) return
    const { modules, preset } = moveModule(stagedPreferences.modules, activeId, overId)
    setStagedPreferences({
      ...stagedPreferences,
      modules,
      preset,
    })
  }

  const handleToggleModule = (id: DashboardModuleId, enabled: boolean) => {
    if (!stagedPreferences) return
    const { modules, preset } = toggleModule(stagedPreferences.modules, id, enabled)
    setStagedPreferences({
      ...stagedPreferences,
      modules,
      preset,
    })
  }

  const handleChangeModuleSize = (id: DashboardModuleId, size: DashboardModuleSize) => {
    if (!stagedPreferences) return
    const { modules, preset } = changeModuleSize(stagedPreferences.modules, id, size)
    setStagedPreferences({
      ...stagedPreferences,
      modules,
      preset,
    })
  }

  const handleSelectPreset = (presetId: 'homelab' | 'business' | 'wall') => {
    if (!stagedPreferences || !catalog) return
    const next = applyPreset(catalog, stagedPreferences, presetId)
    setStagedPreferences(next)
  }

  const handleResetDefault = () => {
    if (!stagedPreferences || !catalog) return
    const next = applyPreset(catalog, stagedPreferences, 'business')
    setStagedPreferences(next)
  }

  const isWall = activePreferences?.preset === 'wall' && !isUser
  const search = useSearch({ strict: false }) as { kiosk?: boolean }
  const isKioskMode = Boolean(search.kiosk && isWall)

  // Render module switch
  const renderModule = (id: DashboardModuleId, size: DashboardModuleSize) => {
    switch (id) {
      case 'fleet-pulse':
        return <FleetPulseModule size={size} isWall={isWall} />
      case 'quick-connect':
        return <QuickConnectModule size={size} isWall={isWall} />
      case 'approval-queue':
        return <ApprovalQueueModule size={size} isWall={isWall} />
      case 'needs-attention':
        return <NeedsAttentionModule size={size} isWall={isWall} />
      case 'live-sessions':
        return <LiveSessionsModule size={size} isWall={isWall} />
      case 'activity-trend':
        return <ActivityTrendModule size={size} isWall={isWall} />
      case 'fleet-overview':
        return <FleetOverviewModule size={size} isWall={isWall} />
      case 'recent-sessions':
        return <RecentSessionsModule size={size} isWall={isWall} />
      case 'session-analytics':
        return <SessionAnalyticsModule size={size} />
      case 'platform-mix':
        return <PlatformMixModule size={size} />
      case 'admin-activity':
        return <AdminActivityModule size={size} isWall={isWall} />
    }
  }

  if (isLoadingError) {
    return (
      <div className="p-6">
        <ErrorState error={error} retry={refetch} />
      </div>
    )
  }

  if (isLoading || !catalog || !activePreferences) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-24" />
        </div>
        <div className="dashboard-bento-grid">
          <Skeleton className="h-44 [grid-column:1/-1]" />
          <Skeleton className="h-88 [grid-column:span_2]" />
          <Skeleton className="h-88 [grid-column:span_2]" />
        </div>
      </div>
    )
  }

  return (
    <div
      style={
        isWall
          ? ({
              '--wall-grid-height': isKioskMode ? 'calc(100dvh - 2rem)' : 'calc(100dvh - 12.5rem)',
            } as React.CSSProperties)
          : undefined
      }
      className={cn(
        'flex flex-col',
        isWall
          ? isKioskMode
            ? 'p-3 md:p-4 lg:flex-1 lg:min-h-0'
            : 'gap-4 lg:flex-1 lg:min-h-0'
          : 'gap-6',
      )}
    >
      {/* Header */}
      {!isKioskMode && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Command Center</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Fleet monitoring and remote management
            </p>
          </div>

          {/* Action Controls */}
          <div className="flex items-center gap-2">
            {isEditMode ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsDrawerOpen(true)}
                  data-slot="dashboard-drawer-trigger"
                  className="gap-1.5"
                >
                  <SlidersHorizontalIcon className="size-3.5" />
                  <span>Modules & Presets</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                  className="gap-1"
                >
                  <XIcon className="size-3.5" />
                  <span>Cancel</span>
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="gap-1.5"
                >
                  <CheckIcon className="size-3.5" />
                  <span>{isSaving ? 'Saving...' : 'Save layout'}</span>
                </Button>
              </>
            ) : isWall ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStagedPreferences(structuredClone(preferences!))
                    setIsDrawerOpen(true)
                  }}
                  className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <SlidersHorizontalIcon className="size-3.5" />
                  <span>Change layout</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  asChild
                  className="gap-1.5 text-xs"
                >
                  <Link
                    to="/"
                    search={(prev: Record<string, unknown>) => ({
                      ...prev,
                      kiosk: 1 as unknown as boolean,
                    })}
                  >
                    <Maximize2Icon className="size-3.5" />
                    <span>Kiosk mode</span>
                  </Link>
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleStartEdit}
                className="gap-1.5"
              >
                <LayoutGridIcon className="size-3.5" />
                <span>Customize</span>
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Grid Layout */}
      {hasNoDevices ? (
        <EmptyState
          title="No devices"
          description="No devices are assigned to you yet. Ask an owner to assign devices or groups."
        />
      ) : isUser && summary.isLoading ? (
        <Skeleton className="h-44 w-full" />
      ) : (
        <DashboardLayout
          catalog={catalog}
          preferences={activePreferences}
          isEditMode={isEditMode}
          isKioskMode={isKioskMode}
          renderModule={renderModule}
          onReorder={handleReorder}
          onToggleModule={handleToggleModule}
          onChangeModuleSize={handleChangeModuleSize}
        />
      )}

      {/* Edit Drawer */}
      {stagedPreferences && (
        <EditDrawer
          open={isDrawerOpen}
          onOpenChange={setIsDrawerOpen}
          catalog={catalog}
          stagedPreferences={stagedPreferences}
          onSelectPreset={handleSelectPreset}
          onToggleModule={handleToggleModule}
          onChangeModuleSize={handleChangeModuleSize}
          onResetDefault={handleResetDefault}
          onSave={handleSave}
          onCancel={handleCancelEdit}
          isSaving={isSaving}
        />
      )}
    </div>
  )
}
