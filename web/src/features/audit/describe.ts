import type { components } from '@/api/schema'

export type AuditEvent = components['schemas']['AuditEvent']

export interface DescribedAudit {
  text: string
  suffix?: string
  deviceId?: string
}

export interface AuditDetails {
  username?: string
  name?: string
  after?: string | { name?: string }
  before?: unknown
  rustdesk_id?: string
  alias?: string
  hostname?: string
  action?: string
  relay?: boolean | number
  from?: unknown
  to?: unknown
  [key: string]: unknown
}

/**
 * Translates an audit log event into human-readable action text and optional target device ID.
 * Device targets return deviceId so the caller can resolve the device name.
 * Incorporates detail names (group name, tag name, username, etc.) when present.
 */
export function describeAudit(event: AuditEvent): DescribedAudit {
  const details = event.details as AuditDetails | undefined

  switch (event.action) {
    // ---- Devices (12 actions) ----
    case 'device.approved':
      return { text: 'approved', deviceId: event.target_id }
    case 'device.rejected':
      return { text: 'rejected', deviceId: event.target_id }
    case 'device.archived':
      return { text: 'archived', deviceId: event.target_id }
    case 'device.reopened':
      return { text: 'reopened', deviceId: event.target_id }
    case 'device.restored':
      return { text: 'restored', deviceId: event.target_id }
    case 'device.updated':
      return { text: 'updated', deviceId: event.target_id }
    case 'device.connect_link':
      return { text: 'generated a connect link for', deviceId: event.target_id }
    case 'device.enrolled':
      return { text: 'enrolled', deviceId: event.target_id }
    case 'device.enroll_dropped':
      return { text: 'dropped enrollment for', deviceId: event.target_id }
    case 'device.uuid_mismatch':
      return { text: 'reported uuid mismatch for', deviceId: event.target_id }
    case 'device.alert_resolved':
      return { text: 'resolved alert on', deviceId: event.target_id }
    case 'device.id_blocked':
      return { text: 'blocked a RustDesk ID on', deviceId: event.target_id }
    case 'device.login_locked_out':
    case 'device.login_locked_out_repeated': {
      const id = typeof details?.rustdesk_id === 'string' ? details.rustdesk_id : 'unknown ID'
      const ip = typeof details?.ip === 'string' ? details.ip : 'unknown IP'
      const count = typeof details?.count === 'number' ? details.count : 0
      return {
        text: `RustDesk locked out ${id} from ${ip} after too many failed sign-ins on`,
        ...(event.action === 'device.login_locked_out_repeated'
          ? { suffix: ` (Repeated attempts: ${count})` }
          : {}),
        deviceId: event.target_id,
      }
    }
    case 'device.id_blocked_repeated': {
      const count = typeof details?.count === 'number' ? details.count : 0
      const first = typeof details?.first_seen === 'string' ? details.first_seen : 'unknown time'
      const last = typeof details?.last_seen === 'string' ? details.last_seen : 'unknown time'
      return {
        text: 'repeatedly blocked a RustDesk ID on',
        suffix: ` (Repeated attempts: ${count} between ${first} and ${last})`,
        deviceId: event.target_id,
      }
    }
    case 'device.id_blocked_overflow': {
      const count = typeof details?.count === 'number' ? details.count : 0
      const first = typeof details?.first_seen === 'string' ? details.first_seen : 'unknown time'
      const last = typeof details?.last_seen === 'string' ? details.last_seen : 'unknown time'
      return {
        text: `Blocked attempts from ${count} other IDs between ${first} and ${last}`,
        deviceId: event.target_id,
      }
    }
    case 'device.deleted': {
      const name =
        (typeof details?.alias === 'string' && details.alias) ||
        (typeof details?.hostname === 'string' && details.hostname) ||
        (typeof details?.rustdesk_id === 'string' && details.rustdesk_id) ||
        ''
      return { text: name ? `deleted ${name}` : 'deleted device' }
    }
    case 'access_window.opened':
      return { text: 'opened an access window on', deviceId: event.target_id }
    case 'access_window.closed':
      if (details?.reason === 'expired') {
        return { text: 'access window expired on', deviceId: event.target_id }
      }
      return { text: 'closed the access window on', deviceId: event.target_id }

    // ---- Auth (6 actions) ----
    case 'auth.login':
      if (details?.method === 'oidc') return { text: 'signed in through the provider' }
      return { text: 'signed in' }
    case 'auth.login_failed':
      if (details?.method === 'oidc') {
        const reason =
          typeof details.reason === 'string'
            ? details.reason.replaceAll('_', ' ')
            : 'unknown reason'
        return { text: `failed to sign in through the provider (${reason})` }
      }
      if (details?.username) {
        return { text: `failed sign-in attempt for "${details.username}"` }
      }
      return { text: 'failed sign-in attempt' }
    case 'auth.logout':
      return { text: 'signed out' }
    case 'auth.mfa_passed':
      return { text: 'passed two-factor verification' }
    case 'auth.password_changed':
      return { text: 'changed password' }
    case 'auth.totp_enrolled':
      return { text: 'enrolled two-factor authenticator' }

    // ---- Setup (3 actions) ----
    case 'setup.owner_created':
      if (details?.username) {
        return { text: `created the owner account "${details.username}"` }
      }
      return { text: 'created the owner account' }
    case 'setup.server_saved':
      if (details?.name) {
        return { text: `saved server setup configuration "${details.name}"` }
      }
      return { text: 'saved server setup configuration' }
    case 'setup.completed':
      return { text: 'finished first-run setup' }

    // ---- Groups (4 actions) ----
    case 'group.created':
      if (details?.name) {
        return { text: `created group "${details.name}"` }
      }
      return { text: 'created group' }
    case 'group.renamed': {
      const afterName =
        typeof details?.after === 'string'
          ? details.after
          : typeof details?.after === 'object' && details?.after !== null
            ? (details.after as { name?: string }).name
            : undefined
      if (afterName) {
        return { text: `renamed group to "${afterName}"` }
      }
      if (details?.name) {
        return { text: `renamed group "${details.name}"` }
      }
      return { text: 'renamed group' }
    }
    case 'group.moved':
      return { text: 'moved group' }
    case 'group.deleted':
      if (details?.name) {
        return { text: `deleted group "${details.name}"` }
      }
      return { text: 'deleted group' }
    case 'group.updated':
      return { text: 'updated group' }
    case 'group.policy_changed':
      return { text: 'changed the policy of group' }
    case 'group.rule_added':
    case 'group.rule_removed': {
      const added = event.action === 'group.rule_added'
      const pattern = typeof details?.pattern === 'string' ? ` \`${details.pattern}\`` : ''
      const updated = Array.isArray(details?.conflicts_updated)
        ? details.conflicts_updated.length
        : 0
      const resolved = Array.isArray(details?.conflicts_resolved)
        ? details.conflicts_resolved.length
        : 0
      const counts = [
        updated ? `${updated} conflict${updated === 1 ? '' : 's'} updated` : '',
        resolved ? `${resolved} conflict${resolved === 1 ? '' : 's'} resolved` : '',
      ].filter(Boolean)
      return {
        text: `${added ? 'added' : 'removed'} the pattern${pattern}${added ? ' to' : ' from'} group`,
        ...(counts.length ? { suffix: ` (${counts.join(', ')})` } : {}),
      }
    }

    // ---- Tags (3 actions) ----
    case 'tag.created':
      if (details?.name) {
        return { text: `created tag "${details.name}"` }
      }
      return { text: 'created tag' }
    case 'tag.updated': {
      const afterName =
        typeof details?.after === 'object' && details?.after !== null
          ? (details.after as { name?: string }).name
          : typeof details?.after === 'string'
            ? details.after
            : undefined
      if (afterName) {
        return { text: `updated tag "${afterName}"` }
      }
      if (details?.name) {
        return { text: `updated tag "${details.name}"` }
      }
      return { text: 'updated tag' }
    }
    case 'tag.deleted':
      if (details?.name) {
        return { text: `deleted tag "${details.name}"` }
      }
      return { text: 'deleted tag' }

    // ---- Users (5 actions) ----
    case 'user.created':
      if (details?.username) {
        return { text: `created user "${details.username}"` }
      }
      return { text: 'created user' }
    case 'user.updated':
      return { text: 'updated user' }
    case 'user.grants_updated':
      return { text: 'changed access grants for user' }
    case 'user.password_reset':
      return { text: 'reset the password of user' }
    case 'user.oidc_linked':
      return {
        text: details?.username
          ? `linked "${details.username}" to the sign-in provider`
          : 'linked user to the sign-in provider',
      }
    case 'user.oidc_unlinked':
      return {
        text: details?.username
          ? `unlinked "${details.username}" from the sign-in provider`
          : 'unlinked user from the sign-in provider',
      }
    case 'user.totp_reset':
      return { text: 'reset two-factor authentication for user' }
    case 'user.totp_reset_cli':
      if (details?.username) {
        return { text: `reset two-factor authentication via CLI for user "${details.username}"` }
      }
      return { text: 'reset two-factor authentication via CLI for user' }
    case 'user.unlocked_cli':
      if (details?.username) {
        return { text: `unlocked user via CLI "${details.username}"` }
      }
      return { text: 'unlocked user via CLI' }
    case 'user.deleted':
      return { text: 'deleted user' }

    // ---- Server & Settings (2 actions) ----
    case 'server.updated':
      return { text: 'updated server configuration' }
    case 'settings.dashboard_updated':
      return { text: 'updated dashboard settings' }
    case 'settings.server_updated':
      return { text: 'updated server settings' }
    case 'settings.oidc_updated':
      return { text: 'changed the sign-in settings' }
    case 'settings.log_export_updated':
      return { text: 'changed the log export settings' }
    case 'id_allow_list.updated':
      return { text: 'updated an ID allow list' }
    case 'ferricade.test':
      return { text: 'sent a log export test event' }
    case 'deployment.password_set':
      return { text: 'set the deployment password' }
    case 'deployment.password_removed':
      return { text: 'removed the deployment password' }
    case 'deployment.pin_set':
      return { text: 'set the deployment PIN' }
    case 'deployment.pin_removed':
      return { text: 'removed the deployment PIN' }
    case 'deployment.profile_updated':
      return { text: 'updated the deployment profile' }
    case 'deployment.script_downloaded':
      return {
        text: `downloaded a${details?.os === 'windows' ? ' Windows' : details?.os === 'linux' ? ' Linux' : ''} deployment script`,
      }
    case 'devices.auto_sorted': {
      const count = (key: string) => (typeof details?.[key] === 'number' ? details[key] : 0)
      return {
        text: `ran Auto Sort: ${count('moved')} moved, ${count('conflicts')} conflicts, ${count('resolved')} resolved, ${count('unchanged')} unchanged`,
      }
    }
    case 'session.disconnect_requested': {
      const conn = typeof details?.conn_id === 'string' ? ` ${details.conn_id}` : ''
      return {
        text: `requested a disconnect for remote session${conn} on`,
        deviceId: typeof details?.device_id === 'string' ? details.device_id : undefined,
      }
    }
    case 'session.started':
    case 'session.updated':
    case 'session.ended': {
      const name = typeof details?.peer_name === 'string' ? details.peer_name : ''
      const id = typeof details?.peer_rustdesk_id === 'string' ? details.peer_rustdesk_id : ''
      const peer = name ? `${name}${id ? ` (${id})` : ''}` : id || 'a peer'
      const verb =
        event.action === 'session.started'
          ? 'started'
          : event.action === 'session.ended'
            ? 'ended'
            : 'updated'
      return {
        text: `${verb} remote session with ${peer} on`,
        deviceId: event.target_type === 'device' ? event.target_id : undefined,
      }
    }
    case 'session_lifetime.changed': {
      const label = (value: unknown) => {
        if (typeof value !== 'string') return String(value ?? '')
        return (
          {
            browser: 'Until the browser closes',
            '8h': '8 hours',
            '1d': '1 day',
            '7d': '7 days',
            '30d': '30 days',
          }[value] ?? value
        )
      }
      return {
        text: `changed the sign-in duration from ${label(details?.before)} to ${label(details?.after)}`,
      }
    }

    // ---- Policies & Policy Push (5 actions) ----
    case 'policy.created':
      return { text: 'created policy' }
    case 'policy.updated':
      return { text: 'updated policy' }
    case 'policy.deleted':
      return { text: 'deleted policy' }
    case 'policy_push.enabled':
      return { text: 'turned on policy push' }
    case 'policy_push.disabled':
      return { text: 'turned off policy push' }

    default:
      return { text: event.action.replace(/[._]/g, ' ') }
  }
}

/**
 * The device an entry links to and looks up for its name: the one its
 * description names, else its device target. A device.deleted entry has
 * none: the device is gone, and its text already names it.
 */
export function auditDeviceTarget(
  event: AuditEvent,
  described: DescribedAudit = describeAudit(event),
): string | undefined {
  if (event.action === 'device.deleted') return undefined
  return described.deviceId || (event.target_type === 'device' ? event.target_id : undefined)
}
