import type { components } from '@/api/schema'

/** pinned_device_ids holds at most this many (maxItems in openapi.yaml). */
export const PIN_LIMIT = 24

export type DashboardCatalog = components['schemas']['DashboardCatalog']
export type DashboardModuleId = components['schemas']['DashboardModuleId']
export type DashboardModuleSize = components['schemas']['DashboardModuleSize']
export type Preferences = components['schemas']['Preferences']
export type PresetId = components['schemas']['Preferences']['preset']

/**
 * Ensures preferences conform to the catalog:
 * - Every catalog module is present exactly once in display order.
 * - Obsolete modules not in catalog are dropped.
 * - Stored sizes must be offered by the catalog module; otherwise falls back to default_size.
 * - Newly added catalog modules are appended, disabled at default_size.
 * - If no preferences are provided, initializes with the Business preset.
 */
export function reconcilePreferences(
  catalog: DashboardCatalog,
  stored?: Partial<Preferences> | null,
): Preferences {
  const catalogModuleMap = new Map(catalog.modules.map((m) => [m.id, m]))

  // If no stored preferences or no modules, fallback to business preset
  if (!stored || !Array.isArray(stored.modules) || stored.modules.length === 0) {
    const defaultPrefs: Preferences = {
      preset: 'business',
      modules: [],
      pinned_device_ids: stored?.pinned_device_ids ?? [],
      theme: stored?.theme ?? 'system',
      palette: stored?.palette ?? 'default',
      density: stored?.density ?? 'comfortable',
      toast_seconds: stored?.toast_seconds ?? 5,
    }
    return applyPreset(catalog, defaultPrefs, 'business')
  }

  // 1. Keep valid stored modules in their existing order
  const seen = new Set<DashboardModuleId>()
  const validModules: Preferences['modules'] = []

  for (const m of stored.modules) {
    const cm = catalogModuleMap.get(m.id)
    if (cm && !seen.has(m.id)) {
      seen.add(m.id)
      const offersSize = cm.sizes.some((s) => s.name === m.size)
      validModules.push({
        id: m.id,
        enabled: Boolean(m.enabled),
        size: offersSize ? m.size! : cm.default_size,
      })
    }
  }

  // 2. Append any missing catalog modules, disabled at their default_size
  for (const cm of catalog.modules) {
    if (!seen.has(cm.id)) {
      seen.add(cm.id)
      validModules.push({
        id: cm.id,
        enabled: false,
        size: cm.default_size,
      })
    }
  }

  return {
    preset: stored.preset ?? 'custom',
    modules: validModules,
    pinned_device_ids: Array.isArray(stored.pinned_device_ids)
      ? stored.pinned_device_ids.slice(0, PIN_LIMIT)
      : [],
    theme: stored.theme ?? 'system',
    palette: stored.palette ?? 'default',
    density: stored.density ?? 'comfortable',
    toast_seconds: stored.toast_seconds ?? 5,
  }
}

/**
 * Applies a preset from the catalog:
 * - Each preset module is enabled at the preset's size, in the preset's order.
 * - Remaining catalog modules are appended disabled at their default_size.
 * - Preset field is set to the preset ID.
 */
export function applyPreset(
  catalog: DashboardCatalog,
  current: Preferences,
  presetId: 'homelab' | 'business' | 'wall',
): Preferences {
  const preset = catalog.presets.find((p) => p.id === presetId)
  if (!preset) return current

  const presetIds = new Set(preset.modules.map((m) => m.id))

  const enabledModules = preset.modules.map((pm) => ({
    id: pm.id,
    enabled: true,
    size: pm.size,
  }))

  const disabledModules = catalog.modules
    .filter((m) => !presetIds.has(m.id))
    .map((m) => ({
      id: m.id,
      enabled: false,
      size: m.default_size,
    }))

  return {
    ...current,
    preset: presetId,
    modules: [...enabledModules, ...disabledModules],
  }
}

/**
 * Reorders modules by moving an item from activeIndex to overIndex.
 * Leaves enabled states and sizes unchanged and sets preset to 'custom'.
 */
export function moveModule(
  modules: Preferences['modules'],
  activeId: DashboardModuleId,
  overId: DashboardModuleId,
): { modules: Preferences['modules']; preset: PresetId } {
  const oldIndex = modules.findIndex((m) => m.id === activeId)
  const newIndex = modules.findIndex((m) => m.id === overId)

  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
    return { modules, preset: 'custom' }
  }

  const next = [...modules]
  const [removed] = next.splice(oldIndex, 1)
  if (removed) {
    next.splice(newIndex, 0, removed)
  }

  return { modules: next, preset: 'custom' }
}

/**
 * Toggles a module's enabled status.
 * Leaves module position and size unchanged and sets preset to 'custom'.
 */
export function toggleModule(
  modules: Preferences['modules'],
  id: DashboardModuleId,
  enabled: boolean,
): { modules: Preferences['modules']; preset: PresetId } {
  const next = modules.map((m) => (m.id === id ? { ...m, enabled } : m))
  return { modules: next, preset: 'custom' }
}

/**
 * Changes a module's size.
 * Leaves module position and enabled status unchanged and sets preset to 'custom'.
 */
export function changeModuleSize(
  modules: Preferences['modules'],
  id: DashboardModuleId,
  size: DashboardModuleSize,
): { modules: Preferences['modules']; preset: PresetId } {
  const next = modules.map((m) => (m.id === id ? { ...m, size } : m))
  return { modules: next, preset: 'custom' }
}

/**
 * Gets grid dimensions (cols, rows) for a module given its size.
 */
export function getModuleGridDimensions(
  catalog: DashboardCatalog,
  moduleId: DashboardModuleId,
  sizeName: DashboardModuleSize,
): { cols: number; rows: number } {
  const mod = catalog.modules.find((m) => m.id === moduleId)
  if (!mod) return { cols: 2, rows: 2 }
  const sizeDef = mod.sizes.find((s) => s.name === sizeName)
  if (sizeDef) return { cols: sizeDef.cols, rows: sizeDef.rows }
  const defaultDef = mod.sizes.find((s) => s.name === mod.default_size)
  if (defaultDef) return { cols: defaultDef.cols, rows: defaultDef.rows }
  return { cols: 2, rows: 2 }
}
