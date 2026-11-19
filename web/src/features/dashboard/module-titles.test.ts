import { describe, expect, it } from 'vitest'
import type { components } from '@/api/schema'
import { moduleTitles } from './module-titles'

describe('dashboard module titles', () => {
  it('has a title for every module in the generated schema', () => {
    const ids: components['schemas']['DashboardModuleId'][] = [
      'fleet-pulse',
      'quick-connect',
      'approval-queue',
      'needs-attention',
      'live-sessions',
      'activity-trend',
      'fleet-overview',
      'recent-sessions',
      'session-analytics',
      'platform-mix',
      'admin-activity',
    ]
    expect(Object.keys(moduleTitles).sort()).toEqual(ids.sort())
    expect(Object.values(moduleTitles).every((title) => title.length > 0)).toBe(true)
  })
})
