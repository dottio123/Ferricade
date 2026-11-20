import * as React from 'react'
import { ChevronDownIcon, FilterXIcon } from 'lucide-react'
import type { User } from '@/features/audit/actor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DateRangeFilter } from '@/components/date-range-filter'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export interface AuditFilters {
  action?: string
  actor?: string
  target?: string
  range?: '24h' | '7d' | '30d' | 'all' | 'custom'
  since?: string
  until?: string
  startDate?: string
  endDate?: string
}

export interface AuditFilterBarProps {
  filters: AuditFilters
  onChange: (filters: Partial<AuditFilters>) => void
  onReset: () => void
  isOwner: boolean
  users: User[]
  currentUserId?: string
  /** No actor filter: a User's log holds only their own actions. */
  hideActor?: boolean
}

export const ACTION_GROUPS = [
  {
    label: 'Sign-in & Security',
    actions: [
      { id: 'auth.login', label: 'Signed in' },
      { id: 'auth.login_failed', label: 'Failed sign-in attempt' },
      { id: 'auth.logout', label: 'Signed out' },
      { id: 'auth.mfa_passed', label: 'MFA verified' },
      { id: 'auth.password_changed', label: 'Changed password' },
      { id: 'auth.totp_enrolled', label: 'Enrolled authenticator' },
      { id: 'user.oidc_linked', label: 'Linked provider sign-in' },
      { id: 'user.oidc_unlinked', label: 'Unlinked provider sign-in' },
    ],
  },
  {
    label: 'Devices',
    actions: [
      { id: 'device.approved', label: 'Approved device' },
      { id: 'device.rejected', label: 'Rejected device' },
      { id: 'device.archived', label: 'Archived device' },
      { id: 'device.reopened', label: 'Reopened device' },
      { id: 'device.restored', label: 'Restored device' },
      { id: 'device.updated', label: 'Updated device' },
      { id: 'device.deleted', label: 'Deleted device' },
      { id: 'device.enrolled', label: 'Enrolled device' },
      { id: 'device.enroll_dropped', label: 'Dropped enrollment' },
      { id: 'device.alert_resolved', label: 'Resolved alert' },
      { id: 'device.uuid_mismatch', label: 'UUID mismatch' },
      { id: 'device.login_locked_out', label: 'RustDesk sign-in lockout' },
      { id: 'device.login_locked_out_repeated', label: 'Repeated RustDesk sign-in lockouts' },
      { id: 'device.id_blocked', label: 'Blocked RustDesk ID' },
      { id: 'device.id_blocked_repeated', label: 'Repeatedly blocked RustDesk ID' },
      { id: 'device.id_blocked_overflow', label: 'Blocked IDs (overflow)' },
      { id: 'device.connect_link', label: 'Generated connect link' },
      { id: 'session.disconnect_requested', label: 'Requested session disconnect' },
      { id: 'devices.auto_sorted', label: 'Auto sorted devices' },
      { id: 'access_window.opened', label: 'Opened access window' },
      { id: 'access_window.closed', label: 'Closed access window' },
    ],
  },
  {
    label: 'Groups',
    actions: [
      { id: 'group.created', label: 'Created group' },
      { id: 'group.renamed', label: 'Renamed group' },
      { id: 'group.moved', label: 'Moved group' },
      { id: 'group.deleted', label: 'Deleted group' },
      { id: 'group.policy_changed', label: 'Changed group policy' },
      { id: 'group.rule_added', label: 'Added group rule' },
      { id: 'group.rule_removed', label: 'Removed group rule' },
    ],
  },
  {
    label: 'Client policies',
    actions: [
      { id: 'policy.created', label: 'Created policy' },
      { id: 'policy.updated', label: 'Updated policy' },
      { id: 'policy.deleted', label: 'Deleted policy' },
      { id: 'policy_push.enabled', label: 'Turned on policy push' },
      { id: 'policy_push.disabled', label: 'Turned off policy push' },
    ],
  },
  {
    label: 'Tags',
    actions: [
      { id: 'tag.created', label: 'Created tag' },
      { id: 'tag.updated', label: 'Updated tag' },
      { id: 'tag.deleted', label: 'Deleted tag' },
    ],
  },
  {
    label: 'Users',
    actions: [
      { id: 'user.created', label: 'Created user' },
      { id: 'user.updated', label: 'Updated user' },
      { id: 'user.totp_reset', label: 'Reset user TOTP' },
      { id: 'user.totp_reset_cli', label: 'Reset user TOTP (CLI)' },
      { id: 'user.grants_updated', label: 'Changed user access grants' },
      { id: 'user.password_reset', label: 'Reset user password' },
      { id: 'user.unlocked_cli', label: 'Unlocked user (CLI)' },
    ],
  },
  {
    label: 'Server & Settings',
    actions: [
      { id: 'server.updated', label: 'Updated server configuration' },
      { id: 'settings.dashboard_updated', label: 'Updated dashboard settings' },
      { id: 'session_lifetime.changed', label: 'Changed sign-in duration' },
      { id: 'settings.log_export_updated', label: 'Changed log export settings' },
      { id: 'settings.oidc_updated', label: 'Changed provider settings' },
      { id: 'id_allow_list.updated', label: 'Updated ID allow list' },
      { id: 'ferricade.test', label: 'Sent log export test event' },
      { id: 'deployment.profile_updated', label: 'Updated deployment profile' },
      { id: 'deployment.password_set', label: 'Set deployment password' },
      { id: 'deployment.password_removed', label: 'Removed deployment password' },
      { id: 'deployment.pin_set', label: 'Set deployment PIN' },
      { id: 'deployment.pin_removed', label: 'Removed deployment PIN' },
      { id: 'deployment.script_downloaded', label: 'Downloaded deployment script' },
    ],
  },
  {
    label: 'Setup',
    actions: [
      { id: 'setup.owner_created', label: 'Owner account created' },
      { id: 'setup.server_saved', label: 'Server setup saved' },
      { id: 'setup.completed', label: 'Setup completed' },
    ],
  },
]

function actionLabel(id: string): string {
  for (const group of ACTION_GROUPS) {
    const found = group.actions.find((a) => a.id === id)
    if (found) return found.label
  }
  return id
}

/** Searchable action picker: typing filters by label and by action id. */
function ActionCombobox({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (action: string | undefined) => void
}) {
  const [open, setOpen] = React.useState(false)
  const pick = (action: string | undefined) => {
    onChange(action)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Filter by action"
          className="h-8 w-full justify-between px-3 text-xs font-normal"
        >
          <span className="truncate">{value ? actionLabel(value) : 'All actions'}</span>
          <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Filter by action" className="w-[260px] p-0">
        <Command label="Search actions">
          <CommandInput placeholder="Search actions…" className="h-9 text-xs" />
          <CommandList className="max-h-[300px]">
            <CommandEmpty className="py-4 text-xs">No matching action</CommandEmpty>
            <CommandItem value="all actions" onSelect={() => pick(undefined)} className="text-xs">
              All actions
            </CommandItem>
            {ACTION_GROUPS.map((group) => (
              <CommandGroup key={group.label} heading={group.label}>
                {group.actions.map((act) => (
                  <CommandItem
                    key={act.id}
                    value={act.id}
                    keywords={[act.label]}
                    onSelect={() => pick(act.id)}
                    className="text-xs"
                  >
                    {act.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function AuditFilterBar({
  filters,
  onChange,
  onReset,
  isOwner,
  users,
  currentUserId,
  hideActor = false,
}: AuditFilterBarProps) {
  const hasActiveFilters = Boolean(
    filters.action ||
    (!hideActor && filters.actor) ||
    filters.target ||
    filters.range ||
    filters.since ||
    filters.until,
  )

  return (
    <div
      data-slot="audit-filter-bar"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 shadow-xs"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        {/* Left: Action select, Actor select, Presets, Target badge */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
          {/* Action Select */}
          <div className="w-full sm:w-[190px]">
            <ActionCombobox value={filters.action} onChange={(action) => onChange({ action })} />
          </div>

          {/* Actor Select: Owner gets "All actors" + user list; Admin gets "Everyone" / "Only me"; a User none */}
          {!hideActor && (
            <div className="w-full sm:w-[160px]">
              <Select
                value={filters.actor ?? 'all'}
                onValueChange={(val) => onChange({ actor: val === 'all' ? undefined : val })}
              >
                <SelectTrigger className="h-8 text-xs w-full" aria-label="Filter by actor">
                  <SelectValue placeholder={isOwner ? 'All actors' : 'Everyone'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{isOwner ? 'All actors' : 'Everyone'}</SelectItem>
                  {isOwner
                    ? users.map((u) => (
                        <SelectItem key={u.id} value={u.id} className="text-xs">
                          {u.display_name || u.username}
                        </SelectItem>
                      ))
                    : currentUserId && (
                        <SelectItem value={currentUserId} className="text-xs">
                          Only me
                        </SelectItem>
                      )}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Time range preset buttons */}
          <DateRangeFilter filters={filters} onChange={onChange} part="presets" />

          {/* Active target filter badge */}
          {filters.target && (
            <Badge
              variant="secondary"
              className="h-7 px-2 text-xs gap-1.5 bg-primary/10 text-primary-text border border-primary/20 w-fit"
            >
              <span>Target: {filters.target.slice(0, 10)}…</span>
              <button
                type="button"
                onClick={() => onChange({ target: undefined })}
                className="hover:text-destructive cursor-pointer ml-1"
                aria-label="Clear target filter"
              >
                ×
              </button>
            </Badge>
          )}
        </div>

        {/* Right side: Reset filters button */}
        {hasActiveFilters && (
          <div className="w-full sm:w-auto flex justify-end sm:ml-auto pt-1 sm:pt-0 border-t border-border/40 sm:border-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1 px-2"
              onClick={onReset}
            >
              <FilterXIcon className="size-3" />
              Reset
            </Button>
          </div>
        )}
      </div>

      {/* Custom date range row */}
      <DateRangeFilter filters={filters} onChange={onChange} part="custom" />
    </div>
  )
}
