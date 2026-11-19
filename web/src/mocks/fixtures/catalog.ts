// The dashboard module catalog and presets, as internal/adminapi/catalog.go
// defines them (the backend is the one definition).
import type { components } from '../../api/schema'
import type { DashboardCatalog, Preferences } from './types'

type ModuleId = components['schemas']['DashboardModuleId']
type Size = components['schemas']['DashboardModuleSize']
type Shape = DashboardCatalog['modules'][number]['sizes']

const shape = (...s: [Size, number, number][]): Shape =>
  s.map(([name, cols, rows]) => ({ name, cols, rows }))
const PULSE = shape(['small', 2, 1], ['medium', 4, 1])
const LIST = shape(['small', 1, 2], ['medium', 2, 2], ['large', 2, 3])
const BIG = shape(['small', 2, 2], ['medium', 4, 2], ['large', 4, 3])
const MIX = shape(['small', 1, 2], ['medium', 2, 2])

const preset = (...m: [ModuleId, Size][]) => m.map(([id, size]) => ({ id, size }))

export const CATALOG: DashboardCatalog = {
  modules: [
    { id: 'fleet-pulse', default_size: 'medium', sizes: PULSE },
    { id: 'quick-connect', default_size: 'medium', sizes: LIST },
    { id: 'approval-queue', default_size: 'medium', sizes: LIST },
    { id: 'needs-attention', default_size: 'medium', sizes: LIST },
    { id: 'live-sessions', default_size: 'medium', sizes: LIST },
    { id: 'activity-trend', default_size: 'medium', sizes: BIG },
    { id: 'fleet-overview', default_size: 'medium', sizes: BIG },
    { id: 'recent-sessions', default_size: 'medium', sizes: LIST },
    { id: 'session-analytics', default_size: 'small', sizes: BIG },
    { id: 'platform-mix', default_size: 'medium', sizes: MIX },
    { id: 'admin-activity', default_size: 'medium', sizes: LIST },
  ],
  presets: [
    {
      id: 'homelab',
      name: 'Homelab',
      modules: preset(
        ['fleet-pulse', 'medium'],
        ['needs-attention', 'medium'],
        ['quick-connect', 'medium'],
        ['live-sessions', 'medium'],
        ['recent-sessions', 'medium'],
        ['fleet-overview', 'medium'],
      ),
    },
    {
      id: 'business',
      name: 'Business',
      modules: preset(
        ['fleet-pulse', 'medium'],
        ['needs-attention', 'medium'],
        ['approval-queue', 'medium'],
        ['live-sessions', 'medium'],
        ['fleet-overview', 'small'],
        ['activity-trend', 'medium'],
        ['admin-activity', 'medium'],
        ['platform-mix', 'medium'],
      ),
    },
    {
      id: 'wall',
      name: 'Monitoring wall',
      modules: preset(
        ['fleet-pulse', 'medium'],
        ['needs-attention', 'medium'],
        ['live-sessions', 'medium'],
        ['fleet-overview', 'medium'],
        ['activity-trend', 'medium'],
      ),
    },
  ],
}

export const MODULE_IDS: ModuleId[] = CATALOG.modules.map((m) => m.id)
export const MODULE_SIZES: Size[] = ['small', 'medium', 'large']

/** The module's default size; "" for an unknown module. */
export function defaultSize(id: string): Size | '' {
  return CATALOG.modules.find((m) => m.id === id)?.default_size ?? ''
}

/** Whether module `id` offers `size` (as catalog.go's offersSize). */
export function offersSize(id: string, size: string): boolean {
  return CATALOG.modules.some((m) => m.id === id && m.sizes.some((s) => s.name === size))
}

/** Preferences for a preset: its modules first, enabled, then the rest, disabled. */
export function presetPreferences(
  presetId: 'homelab' | 'business' | 'wall',
  pinned: string[] = [],
): Preferences {
  const preset = CATALOG.presets.find((p) => p.id === presetId)!
  const inPreset = new Set(preset.modules.map((m) => m.id))
  return {
    preset: presetId,
    modules: [
      ...preset.modules.map((m) => ({ id: m.id, enabled: true, size: m.size })),
      ...CATALOG.modules
        .filter((m) => !inPreset.has(m.id))
        .map((m) => ({ id: m.id, enabled: false, size: m.default_size })),
    ],
    pinned_device_ids: pinned,
    theme: 'system',
    palette: 'default',
    density: 'comfortable',
    toast_seconds: 5,
  }
}
