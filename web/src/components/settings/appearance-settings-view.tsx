import { CheckIcon } from 'lucide-react'
import { AccountNavTabs } from '@/components/account/account-nav-tabs'
import { ErrorState } from '@/components/brand/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'
import { useThemeSwitch } from '@/features/appearance/use-theme-switch'
import { PALETTES, useResolvedMode, type Palette, type Theme } from '@/lib/appearance'

const paletteLabels: Record<Palette, string> = {
  default: 'Default',
  graphite: 'Graphite',
  ocean: 'Ocean',
  violet: 'Violet',
  moss: 'Moss',
  sandstone: 'Sandstone',
}
const modes: readonly Theme[] = ['light', 'dark', 'system']

function MiniScreen({ palette, mode }: { palette: Palette; mode: 'light' | 'dark' }) {
  const paletteAttr = palette === 'default' ? {} : { 'data-palette': palette }
  return (
    <div
      aria-hidden="true"
      data-theme={mode}
      {...paletteAttr}
      className="relative flex h-20 w-full flex-col overflow-hidden rounded-md border border-border bg-background select-none"
    >
      {/* Top Header Bar */}
      <div className="flex h-5 shrink-0 items-center justify-between border-b border-border bg-chrome px-2">
        <span className="font-mono text-2xs font-bold tracking-tight text-primary leading-none">
          Ferricade
        </span>
        <div className="flex items-center gap-1.5">
          <div className="h-1.5 w-6 rounded-full bg-muted" />
          <span className="size-1.5 rounded-full bg-status-online" />
        </div>
      </div>

      {/* Main Body: Sidebar + Bento Canvas */}
      <div className="flex flex-1 min-h-0">
        {/* Miniature Sidebar */}
        <div className="flex w-10 shrink-0 flex-col gap-1 border-r border-border bg-chrome p-1">
          <div className="flex h-3 w-full items-center rounded-xs bg-nav-active px-1">
            <div className="h-1 w-5 rounded-full bg-nav-active-foreground" />
          </div>
          <div className="flex h-3 w-full items-center rounded-xs px-1">
            <div className="h-1 w-4 rounded-full bg-muted-foreground/40" />
          </div>
          <div className="flex h-3 w-full items-center rounded-xs px-1">
            <div className="h-1 w-3 rounded-full bg-muted-foreground/30" />
          </div>
        </div>

        {/* Miniature Content Area */}
        <div className="grid flex-1 grid-cols-2 gap-1.5 p-1.5 bg-background">
          {/* Card 1 */}
          <div className="flex flex-col justify-between rounded-xs border border-border bg-card p-1.5">
            <div className="h-1 w-6 rounded-full bg-card-foreground/80" />
            <div className="h-1 w-4 rounded-full bg-muted-foreground/50" />
          </div>
          {/* Card 2 with Primary Action Button */}
          <div className="flex flex-col justify-between rounded-xs border border-border bg-card p-1.5">
            <div className="h-1 w-5 rounded-full bg-card-foreground/80" />
            <div
              data-slot="preview-primary-btn"
              className="flex h-3 w-full items-center justify-center rounded-xs bg-primary"
            >
              <div className="h-0.5 w-4 rounded-full bg-primary-foreground" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function AppearanceSettingsView() {
  const {
    theme,
    palette,
    toastSeconds,
    setTheme,
    setPalette,
    setToastSeconds,
    isLoading,
    preferencesError,
    refetchPreferences,
    error: saveError,
  } = useThemeSwitch()
  const resolvedMode = useResolvedMode(theme)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader title="Appearance" description="Your colour theme and mode. Only you see them." />

      <AccountNavTabs active="appearance" />

      {isLoading ? (
        <div className="flex flex-col gap-4" role="status" aria-label="Loading appearance settings">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : preferencesError ? (
        <ErrorState
          title="Failed to load appearance settings"
          error={preferencesError}
          retry={() => void refetchPreferences()}
        />
      ) : (
        <div className="flex flex-col gap-6">
          <fieldset className="flex flex-col gap-3" disabled={isLoading}>
            <legend className="mb-1 text-sm font-semibold text-foreground">Theme</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {PALETTES.map((option) => (
                <label
                  key={option}
                  className="group relative flex cursor-pointer flex-col gap-3 rounded-lg border border-border bg-card p-3 transition-colors has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name="palette"
                    value={option}
                    checked={palette === option}
                    onChange={() => setPalette(option)}
                  />
                  <span className="flex items-center justify-between gap-2 text-sm font-medium text-card-foreground">
                    <span className="min-w-0 truncate">{paletteLabels[option]}</span>
                    <CheckIcon
                      className={`size-4 shrink-0 text-primary ${
                        palette === option ? '' : 'invisible'
                      }`}
                      aria-hidden="true"
                    />
                  </span>
                  <MiniScreen palette={option} mode={resolvedMode} />
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-wrap gap-3" disabled={isLoading}>
            <legend className="mb-1 w-full text-sm font-semibold text-foreground">Mode</legend>
            {modes.map((mode) => (
              <label
                key={mode}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
              >
                <input
                  type="radio"
                  name="mode"
                  value={mode}
                  checked={theme === mode}
                  onChange={() => setTheme(mode)}
                />
                {mode[0]!.toUpperCase() + mode.slice(1)}
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-2" disabled={isLoading}>
            <legend className="mb-1 text-sm font-semibold text-foreground">Notifications</legend>
            <label htmlFor="toast-duration" className="text-sm font-semibold text-foreground">
              Hide notifications after
            </label>
            <select
              id="toast-duration"
              className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={toastSeconds}
              onChange={(event) =>
                setToastSeconds(Number(event.target.value) as typeof toastSeconds)
              }
            >
              <option value="3">3 seconds</option>
              <option value="5">5 seconds (default)</option>
              <option value="10">10 seconds</option>
              <option value="30">30 seconds</option>
              <option value="0">Until I close them</option>
            </select>
          </fieldset>
          {saveError && (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
