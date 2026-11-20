import type { ReactNode } from 'react'
import { ShieldAlertIcon } from 'lucide-react'
import { useMe } from './session'

/**
 * Shows `children` to the Owner, and "Only owners can <action>." to an Admin
 * who navigated here directly (the server would answer 403 "forbidden").
 */
export function OwnerOnly({ action, children }: { action: string; children: ReactNode }) {
  const me = useMe().data
  if (!me) return null
  if (me.user.role !== 'owner') {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
        >
          <ShieldAlertIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p>Only owners can {action}.</p>
        </div>
      </div>
    )
  }
  return children
}
