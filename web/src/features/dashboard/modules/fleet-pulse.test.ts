import { describe, expect, it } from 'vitest'
import { countAttention, formatChange, formatOpenAlerts, otherIssues } from './fleet-pulse'

const item = (
  kind:
    | 'uuid_mismatch'
    | 'access_window_unconfirmed'
    | 'pending_long'
    | 'offline_long'
    | 'outdated_client',
) => ({
  kind,
  device_id: '00000000-0000-0000-0000-000000000000',
  rustdesk_id: '123',
  name: 'pc',
  since: '2026-10-08T00:00:00Z',
  detail: '',
})

describe('fleet pulse', () => {
  it('words the change versus 24 h ago', () => {
    expect(formatChange(17, 15)).toBe('+2 vs 24 h ago')
    expect(formatChange(3, 4)).toBe('-1 vs 24 h ago')
    expect(formatChange(5, 5)).toBe('no change')
    expect(formatChange(5, undefined)).toBeNull()
  })

  it('counts attention items by kind', () => {
    const counts = countAttention([
      item('uuid_mismatch'),
      item('access_window_unconfirmed'),
      item('offline_long'),
      item('offline_long'),
    ])
    expect(counts).toEqual({
      uuid_mismatch: 1,
      access_window_unconfirmed: 1,
      group_conflict: 0,
      pending_long: 0,
      offline_long: 2,
      outdated_client: 0,
    })
  })

  it('formats open alerts with uuid mismatches and unconfirmed access windows', () => {
    expect(
      formatOpenAlerts({
        uuid_mismatch: 1,
        access_window_unconfirmed: 0,
        group_conflict: 0,
        pending_long: 0,
        offline_long: 0,
        outdated_client: 0,
      }),
    ).toBe('1 uuid mismatch')

    expect(
      formatOpenAlerts({
        uuid_mismatch: 2,
        access_window_unconfirmed: 0,
        group_conflict: 0,
        pending_long: 0,
        offline_long: 0,
        outdated_client: 0,
      }),
    ).toBe('2 uuid mismatches')

    expect(
      formatOpenAlerts({
        uuid_mismatch: 1,
        access_window_unconfirmed: 1,
        group_conflict: 0,
        pending_long: 0,
        offline_long: 0,
        outdated_client: 0,
      }),
    ).toBe('1 uuid mismatch · 1 access window not confirmed')

    expect(
      formatOpenAlerts({
        uuid_mismatch: 0,
        access_window_unconfirmed: 2,
        group_conflict: 0,
        pending_long: 0,
        offline_long: 0,
        outdated_client: 0,
      }),
    ).toBe('0 uuid mismatches · 2 access windows not confirmed')
  })

  it('lists the other issues, or nothing', () => {
    expect(
      otherIssues({
        uuid_mismatch: 3,
        access_window_unconfirmed: 0,
        group_conflict: 0,
        pending_long: 1,
        offline_long: 2,
        outdated_client: 1,
      }),
    ).toBe('2 offline for long · 1 outdated client')
    expect(
      otherIssues({
        uuid_mismatch: 3,
        access_window_unconfirmed: 0,
        group_conflict: 0,
        pending_long: 0,
        offline_long: 0,
        outdated_client: 0,
      }),
    ).toBeNull()
  })
})
