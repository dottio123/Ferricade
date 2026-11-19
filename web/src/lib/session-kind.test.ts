import { describe, expect, it } from 'vitest'
import { sessionKindLabel } from './session-kind'

describe('session kind labels', () => {
  it('uses readable labels for device session history', () => {
    expect(sessionKindLabel('file_transfer')).toBe('File transfer')
    expect(sessionKindLabel('port_forward')).toBe('Port forward')
    expect(sessionKindLabel('remote')).toBe('Remote')
  })
})
