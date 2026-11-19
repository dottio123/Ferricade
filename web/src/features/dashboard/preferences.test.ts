import { describe, expect, it } from 'vitest'
import {
  applyPreset,
  changeModuleSize,
  moveModule,
  reconcilePreferences,
  toggleModule,
  type DashboardCatalog,
  type Preferences,
} from './preferences'

const MOCK_CATALOG: DashboardCatalog = {
  modules: [
    {
      id: 'fleet-pulse',
      default_size: 'large',
      sizes: [
        { name: 'small', cols: 2, rows: 1 },
        { name: 'medium', cols: 4, rows: 1 },
        { name: 'large', cols: 4, rows: 2 },
      ],
    },
    {
      id: 'quick-connect',
      default_size: 'medium',
      sizes: [
        { name: 'small', cols: 1, rows: 2 },
        { name: 'medium', cols: 2, rows: 2 },
        { name: 'large', cols: 2, rows: 3 },
      ],
    },
    {
      id: 'approval-queue',
      default_size: 'medium',
      sizes: [
        { name: 'small', cols: 1, rows: 2 },
        { name: 'medium', cols: 2, rows: 2 },
        { name: 'large', cols: 2, rows: 3 },
      ],
    },
    {
      id: 'needs-attention',
      default_size: 'medium',
      sizes: [
        { name: 'small', cols: 1, rows: 2 },
        { name: 'medium', cols: 2, rows: 2 },
        { name: 'large', cols: 2, rows: 3 },
      ],
    },
    {
      id: 'live-sessions',
      default_size: 'medium',
      sizes: [
        { name: 'small', cols: 1, rows: 2 },
        { name: 'medium', cols: 2, rows: 2 },
        { name: 'large', cols: 2, rows: 3 },
      ],
    },
    {
      id: 'activity-trend',
      default_size: 'large',
      sizes: [
        { name: 'medium', cols: 2, rows: 2 },
        { name: 'large', cols: 4, rows: 2 },
      ],
    },
    {
      id: 'fleet-overview',
      default_size: 'large',
      sizes: [
        { name: 'medium', cols: 2, rows: 2 },
        { name: 'large', cols: 4, rows: 2 },
      ],
    },
    {
      id: 'recent-sessions',
      default_size: 'medium',
      sizes: [
        { name: 'small', cols: 1, rows: 2 },
        { name: 'medium', cols: 2, rows: 2 },
        { name: 'large', cols: 2, rows: 3 },
      ],
    },
    {
      id: 'session-analytics',
      default_size: 'medium',
      sizes: [
        { name: 'small', cols: 1, rows: 2 },
        { name: 'medium', cols: 2, rows: 2 },
        { name: 'large', cols: 2, rows: 3 },
      ],
    },
    {
      id: 'platform-mix',
      default_size: 'small',
      sizes: [
        { name: 'small', cols: 1, rows: 2 },
        { name: 'medium', cols: 2, rows: 2 },
      ],
    },
    {
      id: 'admin-activity',
      default_size: 'medium',
      sizes: [
        { name: 'small', cols: 1, rows: 2 },
        { name: 'medium', cols: 2, rows: 2 },
        { name: 'large', cols: 2, rows: 3 },
      ],
    },
  ],
  presets: [
    {
      id: 'homelab',
      name: 'Homelab',
      modules: [
        { id: 'fleet-pulse', size: 'medium' },
        { id: 'quick-connect', size: 'medium' },
        { id: 'fleet-overview', size: 'medium' },
      ],
    },
    {
      id: 'business',
      name: 'Business',
      modules: [
        { id: 'fleet-pulse', size: 'medium' },
        { id: 'approval-queue', size: 'medium' },
        { id: 'needs-attention', size: 'medium' },
        { id: 'activity-trend', size: 'medium' },
        { id: 'live-sessions', size: 'medium' },
        { id: 'fleet-overview', size: 'medium' },
        { id: 'admin-activity', size: 'medium' },
        { id: 'platform-mix', size: 'medium' },
      ],
    },
    {
      id: 'wall',
      name: 'Monitoring wall',
      modules: [
        { id: 'fleet-pulse', size: 'large' },
        { id: 'activity-trend', size: 'large' },
        { id: 'fleet-overview', size: 'medium' },
      ],
    },
  ],
}

describe('dashboard preferences', () => {
  it('reconciles empty preferences to default business preset with preset sizes', () => {
    const prefs = reconcilePreferences(MOCK_CATALOG, null)
    expect(prefs.preset).toBe('business')
    expect(prefs.palette).toBe('default')
    expect(prefs.modules).toHaveLength(11)

    // First 8 should be enabled in business preset order and with preset sizes
    const enabled = prefs.modules.filter((m) => m.enabled)
    expect(enabled.map((m) => m.id)).toEqual([
      'fleet-pulse',
      'approval-queue',
      'needs-attention',
      'activity-trend',
      'live-sessions',
      'fleet-overview',
      'admin-activity',
      'platform-mix',
    ])
    expect(enabled.every((m) => m.size === 'medium')).toBe(true)

    // Remaining 3 should be disabled at default_size
    const disabled = prefs.modules.filter((m) => !m.enabled)
    expect(disabled.map((m) => m.id)).toEqual([
      'quick-connect',
      'recent-sessions',
      'session-analytics',
    ])
    expect(disabled.find((m) => m.id === 'quick-connect')?.size).toBe('medium')
    expect(disabled.find((m) => m.id === 'recent-sessions')?.size).toBe('medium')
    expect(disabled.find((m) => m.id === 'session-analytics')?.size).toBe('medium')
  })

  it('reconciles preferences with missing, obsolete, and unoffered sizes', () => {
    const stored = {
      preset: 'custom' as const,
      modules: [
        { id: 'quick-connect' as const, enabled: true, size: 'small' as const },
        { id: 'obsolete-module', enabled: true, size: 'small' as const },
        // platform-mix does not offer 'large'; should fall back to default_size 'small'
        { id: 'platform-mix' as const, enabled: true, size: 'large' as const },
        { id: 'fleet-pulse' as const, enabled: false, size: 'large' as const },
      ],
      pinned_device_ids: ['id-1'],
      theme: 'dark' as const,
      palette: 'ocean' as const,
      density: 'compact' as const,
    } as unknown as Preferences

    const reconciled = reconcilePreferences(MOCK_CATALOG, stored)
    expect(reconciled.preset).toBe('custom')
    expect(reconciled.pinned_device_ids).toEqual(['id-1'])
    expect(reconciled.theme).toBe('dark')
    expect(reconciled.palette).toBe('ocean')
    expect(reconciled.density).toBe('compact')

    // Every catalog module must be present exactly once
    expect(reconciled.modules).toHaveLength(11)
    expect(reconciled.modules.find((m) => (m.id as string) === 'obsolete-module')).toBeUndefined()

    // Existing valid modules keep their order and valid size
    expect(reconciled.modules[0]).toEqual({ id: 'quick-connect', enabled: true, size: 'small' })
    // platform-mix fell back to default_size
    expect(reconciled.modules[1]).toEqual({ id: 'platform-mix', enabled: true, size: 'small' })
    expect(reconciled.modules[2]).toEqual({ id: 'fleet-pulse', enabled: false, size: 'large' })

    // Other catalog modules were appended disabled with default_size
    const rest = reconciled.modules.slice(3)
    expect(rest.every((m) => !m.enabled)).toBe(true)
    const approvalQueue = rest.find((m) => m.id === 'approval-queue')
    expect(approvalQueue?.size).toBe('medium')
  })

  it('applies homelab preset setting modules enabled at preset size and rest disabled at default_size', () => {
    const current: Preferences = {
      preset: 'business',
      modules: MOCK_CATALOG.modules.map((m) => ({ id: m.id, enabled: true, size: m.default_size })),
      pinned_device_ids: [],
      theme: 'dark',
      palette: 'default',
      density: 'comfortable',
      toast_seconds: 5,
    }

    const applied = applyPreset(MOCK_CATALOG, current, 'homelab')
    expect(applied.preset).toBe('homelab')

    const enabled = applied.modules.filter((m) => m.enabled)
    expect(enabled.map((m) => m.id)).toEqual(['fleet-pulse', 'quick-connect', 'fleet-overview'])
    expect(enabled.map((m) => m.size)).toEqual(['medium', 'medium', 'medium'])

    const disabled = applied.modules.filter((m) => !m.enabled)
    expect(disabled).toHaveLength(8)
    expect(applied.modules).toHaveLength(11)
  })

  it('moves modules keeping sizes and sets preset to custom', () => {
    const initial: Preferences['modules'] = [
      { id: 'fleet-pulse', enabled: true, size: 'large' },
      { id: 'quick-connect', enabled: true, size: 'small' },
      { id: 'approval-queue', enabled: false, size: 'medium' },
    ]

    const result = moveModule(initial, 'approval-queue', 'fleet-pulse')
    expect(result.preset).toBe('custom')
    expect(result.modules.map((m) => m.id)).toEqual([
      'approval-queue',
      'fleet-pulse',
      'quick-connect',
    ])
    // Sizes and enabled states are preserved
    expect(result.modules[0]).toEqual({ id: 'approval-queue', enabled: false, size: 'medium' })
    expect(result.modules[1]).toEqual({ id: 'fleet-pulse', enabled: true, size: 'large' })
    expect(result.modules[2]).toEqual({ id: 'quick-connect', enabled: true, size: 'small' })
  })

  it('toggles a module keeping size and sets preset to custom', () => {
    const initial: Preferences['modules'] = [
      { id: 'fleet-pulse', enabled: true, size: 'large' },
      { id: 'quick-connect', enabled: false, size: 'small' },
    ]

    const result = toggleModule(initial, 'quick-connect', true)
    expect(result.preset).toBe('custom')
    expect(result.modules[1]).toEqual({ id: 'quick-connect', enabled: true, size: 'small' })
  })

  it('changes module size and sets preset to custom', () => {
    const initial: Preferences['modules'] = [
      { id: 'fleet-pulse', enabled: true, size: 'large' },
      { id: 'quick-connect', enabled: true, size: 'medium' },
    ]

    const result = changeModuleSize(initial, 'quick-connect', 'small')
    expect(result.preset).toBe('custom')
    expect(result.modules[1]).toEqual({ id: 'quick-connect', enabled: true, size: 'small' })
  })
})
