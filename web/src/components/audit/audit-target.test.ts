import { describe, expect, it } from 'vitest'
import { auditTargetLabel } from './audit-target'
import type { AuditEvent } from '@/features/audit/describe'

const event = (target_type: AuditEvent['target_type'], details: Record<string, unknown> = {}) =>
  ({
    target_type,
    target_id: '12345678-abcdef',
    details,
  }) as AuditEvent

describe('audit target labels', () => {
  it('uses names from event details for group and tag targets', () => {
    expect(auditTargetLabel(event('group', { name: 'Engineering' }), [])).toBe('Engineering')
    expect(auditTargetLabel(event('tag', { after: { name: 'Priority' } }), [])).toBe('Priority')
    expect(auditTargetLabel(event('group'), [])).toBeNull()
  })

  it('uses names from event details for policy targets', () => {
    expect(auditTargetLabel(event('policy', { name: 'Strict Policy' }), [])).toBe('Strict Policy')
    expect(auditTargetLabel(event('policy', { after: { name: 'Renamed Policy' } }), [])).toBe(
      'Renamed Policy',
    )
    expect(auditTargetLabel(event('policy'), [])).toBeNull()
  })

  it('uses the users list or a short ID for user targets', () => {
    expect(
      auditTargetLabel(event('user'), [
        { id: '12345678-abcdef', display_name: 'Alex', username: 'alex' },
      ]),
    ).toBe('Alex')
    expect(auditTargetLabel(event('user'), [])).toBe('12345678')
  })
})
