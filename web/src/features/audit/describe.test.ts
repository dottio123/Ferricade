import { describe, expect, it } from 'vitest'
import { auditDeviceTarget, describeAudit, type AuditEvent } from './describe'

function makeEvent(
  action: string,
  target_id = 'target-123',
  details: Record<string, unknown> = {},
): AuditEvent {
  return {
    id: 'evt-1',
    at: '2026-10-08T12:00:00Z',
    actor_user_id: 'user-1',
    actor_ip: '192.168.1.1',
    action,
    target_type: 'device',
    target_id,
    details,
  }
}

const ALL_AUDIT_ACTIONS = [
  'access_window.closed',
  'access_window.opened',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.mfa_passed',
  'auth.password_changed',
  'auth.totp_enrolled',
  'device.alert_resolved',
  'device.approved',
  'device.archived',
  'device.connect_link',
  'device.deleted',
  'device.enroll_dropped',
  'device.enrolled',
  'device.id_blocked',
  'device.id_blocked_repeated',
  'device.id_blocked_overflow',
  'device.login_locked_out',
  'device.login_locked_out_repeated',
  'device.rejected',
  'device.reopened',
  'device.restored',
  'device.updated',
  'device.uuid_mismatch',
  'deployment.password_removed',
  'deployment.password_set',
  'deployment.pin_removed',
  'deployment.pin_set',
  'deployment.profile_updated',
  'deployment.script_downloaded',
  'devices.auto_sorted',
  'group.created',
  'group.deleted',
  'group.moved',
  'group.policy_changed',
  'group.renamed',
  'group.rule_added',
  'group.rule_removed',
  'id_allow_list.updated',
  'policy.created',
  'policy.deleted',
  'policy.updated',
  'policy_push.disabled',
  'policy_push.enabled',
  'server.updated',
  'settings.dashboard_updated',
  'session_lifetime.changed',
  'ferricade.test',
  'session.disconnect_requested',
  'session.ended',
  'session.started',
  'session.updated',
  'settings.log_export_updated',
  'setup.completed',
  'setup.owner_created',
  'setup.server_saved',
  'tag.created',
  'tag.deleted',
  'tag.updated',
  'user.created',
  'user.grants_updated',
  'user.password_reset',
  'user.totp_reset',
  'user.totp_reset_cli',
  'user.unlocked_cli',
  'user.updated',
] as const

describe('describeAudit', () => {
  it('describes RustDesk lockouts and their repeat count', () => {
    const details = {
      rustdesk_id: 'remote',
      ip: '203.0.113.7',
      reason: 'too_many_attempts',
      count: 3,
    }
    expect(describeAudit(makeEvent('device.login_locked_out', 'device-1', details))).toEqual({
      text: 'RustDesk locked out remote from 203.0.113.7 after too many failed sign-ins on',
      deviceId: 'device-1',
    })
    expect(
      describeAudit(makeEvent('device.login_locked_out_repeated', 'device-1', details)),
    ).toEqual({
      text: 'RustDesk locked out remote from 203.0.113.7 after too many failed sign-ins on',
      suffix: ' (Repeated attempts: 3)',
      deviceId: 'device-1',
    })
  })
  it('describes OIDC sign-ins, links, unlinks, and settings changes', () => {
    expect(
      describeAudit(makeEvent('settings.oidc_updated', 's', { changed: ['issuer'] })).text,
    ).toBe('changed the sign-in settings')
    expect(describeAudit(makeEvent('user.oidc_linked', 'u', { username: 'sam' })).text).toBe(
      'linked "sam" to the sign-in provider',
    )
    expect(describeAudit(makeEvent('user.oidc_unlinked', 'u', { username: 'sam' })).text).toBe(
      'unlinked "sam" from the sign-in provider',
    )
    expect(describeAudit(makeEvent('auth.login', 'u', { method: 'oidc' })).text).toBe(
      'signed in through the provider',
    )
    expect(
      describeAudit(makeEvent('auth.login_failed', 'u', { method: 'oidc', reason: 'not_allowed' }))
        .text,
    ).toBe('failed to sign in through the provider (not allowed)')
  })
  it('covers all backend audit actions without hitting fallback', () => {
    for (const action of ALL_AUDIT_ACTIONS) {
      const described = describeAudit(makeEvent(action))
      const fallback = action.replace(/[._]/g, ' ')
      expect(described.text).not.toBe(fallback)
      expect(described.text.length).toBeGreaterThan(0)
    }
  })

  it('describes ID allow-list changes and repeated blocked-ID attempts', () => {
    expect(describeAudit(makeEvent('id_allow_list.updated')).text).toBe('updated an ID allow list')
    expect(describeAudit(makeEvent('device.id_blocked')).text).toBe('blocked a RustDesk ID on')
    expect(
      describeAudit(
        makeEvent('device.id_blocked_repeated', 'device-1', {
          count: 4,
          first_seen: '2026-11-12T10:00:00Z',
          last_seen: '2026-11-12T10:04:00Z',
        }),
      ),
    ).toEqual({
      text: 'repeatedly blocked a RustDesk ID on',
      suffix: ' (Repeated attempts: 4 between 2026-11-12T10:00:00Z and 2026-11-12T10:04:00Z)',
      deviceId: 'device-1',
    })
    expect(
      describeAudit(
        makeEvent('device.id_blocked_overflow', 'device-1', {
          count: 8,
          first_seen: '2026-11-12T10:00:00Z',
          last_seen: '2026-11-12T10:04:00Z',
        }),
      ),
    ).toEqual({
      text: 'Blocked attempts from 8 other IDs between 2026-11-12T10:00:00Z and 2026-11-12T10:04:00Z',
      deviceId: 'device-1',
    })
  })

  it('describes deployment password set without exposing its value', () => {
    expect(
      describeAudit(makeEvent('deployment.password_set', 's', { password: 'secret-value' })).text,
    ).toBe('set the deployment password')
  })
  it('describes deployment password removal without exposing its value', () => {
    expect(
      describeAudit(makeEvent('deployment.password_removed', 's', { password: 'secret-value' }))
        .text,
    ).toBe('removed the deployment password')
  })
  it('describes deployment PIN set without exposing its value', () => {
    expect(describeAudit(makeEvent('deployment.pin_set', 's', { pin: '123456' })).text).toBe(
      'set the deployment PIN',
    )
  })
  it('describes deployment PIN removal without exposing its value', () => {
    expect(describeAudit(makeEvent('deployment.pin_removed', 's', { pin: '123456' })).text).toBe(
      'removed the deployment PIN',
    )
  })
  it('describes deployment profile updates', () => {
    expect(
      describeAudit(
        makeEvent('deployment.profile_updated', 's', {
          before: { installer_source: 'url' },
          after: { installer_source: 'bundled' },
        }),
      ).text,
    ).toBe('updated the deployment profile')
  })
  it('describes deployment script downloads by operating system', () => {
    expect(
      describeAudit(
        makeEvent('deployment.script_downloaded', 's', {
          os: 'windows',
          clears_password: false,
          clears_pin: false,
        }),
      ).text,
    ).toBe('downloaded a Windows deployment script')
  })
  it('describes automatic device sorting counts', () => {
    expect(
      describeAudit(
        makeEvent('devices.auto_sorted', 'devices', {
          moved: 12,
          conflicts: 2,
          resolved: 1,
          unchanged: 8,
        }),
      ).text,
    ).toBe('ran Auto Sort: 12 moved, 2 conflicts, 1 resolved, 8 unchanged')
  })
  it('describes added group rules and conflict counts', () => {
    expect(
      describeAudit(
        makeEvent('group.rule_added', 'g-1', {
          pattern: 'w-*',
          conflicts_updated: ['a', 'b'],
          conflicts_resolved: ['c'],
        }),
      ),
    ).toEqual({
      text: 'added the pattern `w-*` to group',
      suffix: ' (2 conflicts updated, 1 conflict resolved)',
    })
  })
  it('describes removed group rules and conflict counts', () => {
    expect(
      describeAudit(
        makeEvent('group.rule_removed', 'g-1', { pattern: 'w-*', conflicts_resolved: ['c'] }),
      ),
    ).toEqual({
      text: 'removed the pattern `w-*` from group',
      suffix: ' (1 conflict resolved)',
    })
  })
  it('describes the ferricade test event plainly', () => {
    expect(describeAudit(makeEvent('ferricade.test', 's')).text).toBe(
      'sent a log export test event',
    )
  })
  it('describes disconnect requests with the session connection', () => {
    expect(
      describeAudit(
        makeEvent('session.disconnect_requested', 's-1', { device_id: 'd-1', conn_id: 'conn-7' }),
      ).text,
    ).toBe('requested a disconnect for remote session conn-7 on')
  })
  it('describes ended remote sessions with the peer', () => {
    expect(
      describeAudit(
        makeEvent('session.ended', 'd-1', { peer_name: 'Bob', peer_rustdesk_id: '123' }),
      ).text,
    ).toBe('ended remote session with Bob (123) on')
  })
  it('describes started remote sessions with the peer', () => {
    expect(
      describeAudit(
        makeEvent('session.started', 'd-1', { peer_name: 'Bob', peer_rustdesk_id: '123' }),
      ).text,
    ).toBe('started remote session with Bob (123) on')
  })
  it('describes updated remote sessions with the peer', () => {
    expect(
      describeAudit(
        makeEvent('session.updated', 'd-1', { peer_name: 'Bob', peer_rustdesk_id: '123' }),
      ).text,
    ).toBe('updated remote session with Bob (123) on')
  })
  it('describes log export settings changes', () => {
    expect(
      describeAudit(
        makeEvent('settings.log_export_updated', 's', { fields: ['enabled', 'format'] }),
      ).text,
    ).toBe('changed the log export settings')
  })
  it('describes user grant changes by target username', () => {
    expect(
      describeAudit(
        makeEvent('user.grants_updated', 'u-1', {
          added_group_ids: ['g-1'],
          removed_device_ids: ['d-1'],
          added_device_ids: [],
          removed_group_ids: [],
        }),
      ).text,
    ).toBe('changed access grants for user')
  })
  it('describes password resets by target username', () => {
    expect(describeAudit(makeEvent('user.password_reset', 'u-1', {})).text).toBe(
      'reset the password of user',
    )
  })

  it('maps sign-in duration changes, preserving unknown values', () => {
    expect(
      describeAudit(
        makeEvent('session_lifetime.changed', undefined, { before: 'browser', after: '7d' }),
      ),
    ).toEqual({ text: 'changed the sign-in duration from Until the browser closes to 7 days' })
    expect(
      describeAudit(
        makeEvent('session_lifetime.changed', undefined, { before: 'future', after: '30d' }),
      ),
    ).toEqual({ text: 'changed the sign-in duration from future to 30 days' })
  })

  it('maps policy and policy push actions', () => {
    expect(describeAudit(makeEvent('policy.created'))).toEqual({ text: 'created policy' })
    expect(describeAudit(makeEvent('policy.updated'))).toEqual({ text: 'updated policy' })
    expect(describeAudit(makeEvent('policy.deleted'))).toEqual({ text: 'deleted policy' })
    expect(describeAudit(makeEvent('policy_push.enabled'))).toEqual({
      text: 'turned on policy push',
    })
    expect(describeAudit(makeEvent('policy_push.disabled'))).toEqual({
      text: 'turned off policy push',
    })
  })

  it('maps group.policy_changed action', () => {
    expect(describeAudit(makeEvent('group.policy_changed'))).toEqual({
      text: 'changed the policy of group',
    })
  })

  it('maps access window actions with deviceId, including expired reason', () => {
    expect(describeAudit(makeEvent('access_window.opened', 'dev-1'))).toEqual({
      text: 'opened an access window on',
      deviceId: 'dev-1',
    })
    expect(describeAudit(makeEvent('access_window.closed', 'dev-1'))).toEqual({
      text: 'closed the access window on',
      deviceId: 'dev-1',
    })
    expect(
      describeAudit(makeEvent('access_window.closed', 'dev-1', { reason: 'expired' })),
    ).toEqual({
      text: 'access window expired on',
      deviceId: 'dev-1',
    })
  })

  it('maps all device actions with deviceId', () => {
    expect(describeAudit(makeEvent('device.approved'))).toEqual({
      text: 'approved',
      deviceId: 'target-123',
    })
    expect(describeAudit(makeEvent('device.rejected'))).toEqual({
      text: 'rejected',
      deviceId: 'target-123',
    })
    expect(describeAudit(makeEvent('device.archived'))).toEqual({
      text: 'archived',
      deviceId: 'target-123',
    })
    expect(describeAudit(makeEvent('device.reopened'))).toEqual({
      text: 'reopened',
      deviceId: 'target-123',
    })
    expect(describeAudit(makeEvent('device.restored'))).toEqual({
      text: 'restored',
      deviceId: 'target-123',
    })
    expect(describeAudit(makeEvent('device.updated'))).toEqual({
      text: 'updated',
      deviceId: 'target-123',
    })
    expect(describeAudit(makeEvent('device.connect_link'))).toEqual({
      text: 'generated a connect link for',
      deviceId: 'target-123',
    })
    expect(describeAudit(makeEvent('device.enrolled'))).toEqual({
      text: 'enrolled',
      deviceId: 'target-123',
    })
    expect(describeAudit(makeEvent('device.enroll_dropped'))).toEqual({
      text: 'dropped enrollment for',
      deviceId: 'target-123',
    })
    expect(describeAudit(makeEvent('device.uuid_mismatch'))).toEqual({
      text: 'reported uuid mismatch for',
      deviceId: 'target-123',
    })
    expect(describeAudit(makeEvent('device.alert_resolved'))).toEqual({
      text: 'resolved alert on',
      deviceId: 'target-123',
    })
  })

  it('maps device.deleted without deviceId, resolving name from details', () => {
    expect(
      describeAudit(makeEvent('device.deleted', 'target-123', { alias: 'Reception PC' })),
    ).toEqual({
      text: 'deleted Reception PC',
    })
    expect(
      describeAudit(makeEvent('device.deleted', 'target-123', { hostname: 'desktop-host' })),
    ).toEqual({
      text: 'deleted desktop-host',
    })
    expect(
      describeAudit(makeEvent('device.deleted', 'target-123', { rustdesk_id: '987654321' })),
    ).toEqual({
      text: 'deleted 987654321',
    })
    expect(describeAudit(makeEvent('device.deleted', 'target-123', {}))).toEqual({
      text: 'deleted device',
    })
  })

  it('maps auth actions, including failed sign-in username details', () => {
    expect(describeAudit(makeEvent('auth.login'))).toEqual({ text: 'signed in' })
    expect(describeAudit(makeEvent('auth.logout'))).toEqual({ text: 'signed out' })
    expect(describeAudit(makeEvent('auth.mfa_passed'))).toEqual({
      text: 'passed two-factor verification',
    })
    expect(describeAudit(makeEvent('auth.password_changed'))).toEqual({ text: 'changed password' })
    expect(describeAudit(makeEvent('auth.totp_enrolled'))).toEqual({
      text: 'enrolled two-factor authenticator',
    })

    // Failed login without and with username
    expect(describeAudit(makeEvent('auth.login_failed'))).toEqual({
      text: 'failed sign-in attempt',
    })
    expect(describeAudit(makeEvent('auth.login_failed', 'u-1', { username: 'alex' }))).toEqual({
      text: 'failed sign-in attempt for "alex"',
    })
  })

  it('maps group actions, including name details', () => {
    expect(describeAudit(makeEvent('group.created'))).toEqual({ text: 'created group' })
    expect(describeAudit(makeEvent('group.created', 'g-1', { name: 'Support' }))).toEqual({
      text: 'created group "Support"',
    })
    expect(describeAudit(makeEvent('group.renamed'))).toEqual({ text: 'renamed group' })
    expect(describeAudit(makeEvent('group.renamed', 'g-1', { after: 'Engineering' }))).toEqual({
      text: 'renamed group to "Engineering"',
    })
    expect(describeAudit(makeEvent('group.moved'))).toEqual({ text: 'moved group' })
    expect(describeAudit(makeEvent('group.deleted'))).toEqual({ text: 'deleted group' })
    expect(describeAudit(makeEvent('group.deleted', 'g-1', { name: 'OldDept' }))).toEqual({
      text: 'deleted group "OldDept"',
    })
  })

  it('maps tag actions, including name details', () => {
    expect(describeAudit(makeEvent('tag.created'))).toEqual({ text: 'created tag' })
    expect(describeAudit(makeEvent('tag.created', 't-1', { name: 'VIP' }))).toEqual({
      text: 'created tag "VIP"',
    })
    expect(describeAudit(makeEvent('tag.updated'))).toEqual({ text: 'updated tag' })
    expect(
      describeAudit(makeEvent('tag.updated', 't-1', { after: { name: 'Executive' } })),
    ).toEqual({
      text: 'updated tag "Executive"',
    })
    expect(describeAudit(makeEvent('tag.deleted'))).toEqual({ text: 'deleted tag' })
    expect(describeAudit(makeEvent('tag.deleted', 't-1', { name: 'Decommissioned' }))).toEqual({
      text: 'deleted tag "Decommissioned"',
    })
  })

  it('maps user and CLI recovery actions, including username details', () => {
    expect(describeAudit(makeEvent('user.created'))).toEqual({ text: 'created user' })
    expect(describeAudit(makeEvent('user.created', 'u-1', { username: 'sam' }))).toEqual({
      text: 'created user "sam"',
    })
    expect(describeAudit(makeEvent('user.updated'))).toEqual({ text: 'updated user' })
    expect(describeAudit(makeEvent('user.totp_reset'))).toEqual({
      text: 'reset two-factor authentication for user',
    })
    expect(describeAudit(makeEvent('user.totp_reset_cli'))).toEqual({
      text: 'reset two-factor authentication via CLI for user',
    })
    expect(describeAudit(makeEvent('user.totp_reset_cli', 'u-1', { username: 'sam' }))).toEqual({
      text: 'reset two-factor authentication via CLI for user "sam"',
    })
    expect(describeAudit(makeEvent('user.unlocked_cli'))).toEqual({
      text: 'unlocked user via CLI',
    })
    expect(describeAudit(makeEvent('user.unlocked_cli', 'u-1', { username: 'sam' }))).toEqual({
      text: 'unlocked user via CLI "sam"',
    })
  })

  it('maps setup, server and dashboard settings actions', () => {
    expect(describeAudit(makeEvent('setup.owner_created'))).toEqual({
      text: 'created the owner account',
    })
    expect(describeAudit(makeEvent('setup.owner_created', 'u-1', { username: 'admin' }))).toEqual({
      text: 'created the owner account "admin"',
    })
    expect(describeAudit(makeEvent('setup.server_saved'))).toEqual({
      text: 'saved server setup configuration',
    })
    expect(
      describeAudit(makeEvent('setup.server_saved', 's-1', { name: 'RustDesk Prod' })),
    ).toEqual({
      text: 'saved server setup configuration "RustDesk Prod"',
    })
    expect(describeAudit(makeEvent('setup.completed'))).toEqual({
      text: 'finished first-run setup',
    })
    expect(describeAudit(makeEvent('server.updated'))).toEqual({
      text: 'updated server configuration',
    })
    expect(describeAudit(makeEvent('settings.dashboard_updated'))).toEqual({
      text: 'updated dashboard settings',
    })
  })

  it('falls back to formatted action string for unknown action', () => {
    expect(describeAudit(makeEvent('custom_scope.something_happened'))).toEqual({
      text: 'custom scope something happened',
    })
  })
})

describe('auditDeviceTarget', () => {
  it('is the device the entry is about', () => {
    expect(auditDeviceTarget(makeEvent('device.approved', 'dev-1'))).toBe('dev-1')
  })

  it('falls back to a device target the description does not link', () => {
    expect(auditDeviceTarget(makeEvent('device.something_new', 'dev-2'))).toBe('dev-2')
  })

  it('has none for a deleted device (it is gone; the text names it)', () => {
    expect(auditDeviceTarget(makeEvent('device.deleted', 'dev-3'))).toBeUndefined()
  })

  it('has none for other targets', () => {
    expect(
      auditDeviceTarget({ ...makeEvent('group.deleted'), target_type: 'group' }),
    ).toBeUndefined()
  })
})
