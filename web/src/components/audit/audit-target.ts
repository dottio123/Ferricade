import type { AuditEvent } from '@/features/audit/describe'

type NamedUser = { id: string; display_name?: string | null; username: string }

export function auditTargetLabel(event: AuditEvent, users: NamedUser[]): string | null {
  const details = (event.details ?? {}) as Record<string, unknown>
  if (event.target_type === 'user') {
    const user = users.find((item) => item.id === event.target_id)
    return user ? user.display_name || user.username : event.target_id?.slice(0, 8) || null
  }
  if (
    event.target_type !== 'group' &&
    event.target_type !== 'tag' &&
    event.target_type !== 'policy'
  )
    return null
  const after = details.after
  const afterName =
    typeof after === 'object' && after !== null ? (after as Record<string, unknown>).name : after
  const name = typeof afterName === 'string' && afterName ? afterName : details.name
  return typeof name === 'string' && name ? name : null
}
