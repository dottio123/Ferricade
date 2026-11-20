import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import { describeError } from '@/api/errors'
import { AlertCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { queryKeys } from '@/lib/queryKeys'
import { PasswordRules, passwordRulesMet } from '@/components/password-rules'
import type { User } from '@/features/audit/actor'

function mapUserError(err: unknown): string {
  const { code, message } = describeError(err)
  if (code === 'username_taken') {
    return 'A user with this username already exists.'
  }
  if (code === 'last_owner') {
    return 'You cannot demote or disable the last active owner.'
  }
  if (code === 'weak_password') {
    return 'Password is too weak. Ensure it is at least 12 characters and not common.'
  }
  return message
}

type Role = components['schemas']['User']['role']

/** The server deletes a User's grants on any role change to or from user. */
export function removesGrants(from: Role, to: Role): boolean {
  return from !== to && (from === 'user' || to === 'user')
}

const USER_ROLE_HELP = 'Sees and connects to the devices you assign'

function RoleOptions() {
  return (
    <>
      <SelectItem value="admin">Admin</SelectItem>
      <SelectItem value="owner">Owner</SelectItem>
      <SelectItem value="user">User</SelectItem>
    </>
  )
}

function useInvalidateUsers(currentUserId?: string) {
  const queryClient = useQueryClient()
  return (editedUserId?: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.users.all() })
    if (currentUserId && editedUserId === currentUserId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me() })
    }
  }
}

// -------------------------------------------------------------
// 1. UserCreateDialog
// -------------------------------------------------------------
export interface UserCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function CreateUserForm({ onClose }: { onClose: () => void }) {
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [role, setRole] = React.useState<Role>('admin')
  const [displayName, setDisplayName] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [totpRequired, setTotpRequired] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [weakPasswordMessage, setWeakPasswordMessage] = React.useState<string | null>(null)
  const invalidate = useInvalidateUsers()
  const { toast } = useToast()

  const validPassword = passwordRulesMet(password, username.trim())

  const createMutation = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/admin/api/v1/users', {
          body: {
            username: username.trim(),
            password,
            role,
            display_name: displayName.trim() || undefined,
            email: email.trim() || undefined,
            totp_required: role === 'owner' ? true : totpRequired,
          },
        }),
      ),
    onSuccess: () => {
      invalidate()
      toast({ title: 'User created' })
      onClose()
    },
    onError: (err) => {
      const { code, message } = describeError(err)
      if (code === 'weak_password') setWeakPasswordMessage(message)
      else setError(mapUserError(err))
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !validPassword) return
    setError(null)
    setWeakPasswordMessage(null)
    createMutation.mutate()
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create new user</DialogTitle>
        <DialogDescription>Add an administrator or owner to manage Ferricade.</DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="user-create-username"
              className="text-xs font-medium text-muted-foreground"
            >
              Username
            </label>
            <Input
              id="user-create-username"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'user-create-error' : undefined}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="jdoe"
              maxLength={64}
              required
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="user-create-role" className="text-xs font-medium text-muted-foreground">
              Role
            </label>
            <Select
              value={role}
              onValueChange={(val: Role) => {
                setRole(val)
                if (val === 'owner') setTotpRequired(true)
              }}
            >
              <SelectTrigger
                id="user-create-role"
                className="w-full"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'user-create-error' : undefined}
              >
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                <RoleOptions />
              </SelectContent>
            </Select>
            {role === 'user' && (
              <span className="text-xs text-muted-foreground">{USER_ROLE_HELP}</span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="user-create-password"
            className="text-xs font-medium text-muted-foreground"
          >
            Password
          </label>
          <Input
            id="user-create-password"
            aria-invalid={Boolean(error)}
            aria-describedby={`user-create-password-rules${error ? ' user-create-error' : ''}`}
            type="password"
            maxLength={256}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setWeakPasswordMessage(null)
              setError(null)
            }}
            autoComplete="new-password"
            required
          />

          <PasswordRules
            id="user-create-password-rules"
            password={password}
            username={username.trim()}
            usernameWording="the"
            weakPasswordMessage={weakPasswordMessage}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="user-create-display-name"
              className="text-xs font-medium text-muted-foreground"
            >
              Display name (optional)
            </label>
            <Input
              id="user-create-display-name"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'user-create-error' : undefined}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Jane Doe"
              maxLength={128}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="user-create-email"
              className="text-xs font-medium text-muted-foreground"
            >
              Email (optional)
            </label>
            <Input
              id="user-create-email"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'user-create-error' : undefined}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jdoe@example.com"
            />
          </div>
        </div>

        {/* TOTP Required Switch */}
        <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex flex-col gap-0.5">
            <label
              htmlFor="user-create-totp-switch"
              className="text-xs font-medium text-foreground"
            >
              Require two-factor authentication
            </label>
            <span className="text-xs text-muted-foreground">
              {role === 'owner'
                ? 'Mandatory for owners.'
                : 'User must enroll TOTP upon signing in.'}
            </span>
          </div>
          <Switch
            id="user-create-totp-switch"
            checked={role === 'owner' ? true : totpRequired}
            disabled={role === 'owner'}
            onCheckedChange={setTotpRequired}
          />
        </div>

        {error && (
          <p id="user-create-error" role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!username.trim() || !validPassword || createMutation.isPending}
          >
            {createMutation.isPending ? 'Creating…' : 'Create user'}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

export function UserCreateDialog({ open, onOpenChange }: UserCreateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="user-create-dialog" className="sm:max-w-md">
        {open && <CreateUserForm onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

// -------------------------------------------------------------
// 2. UserEditDialog
// -------------------------------------------------------------
export interface UserEditDialogProps {
  user: User | null
  currentUserId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function EditUserForm({
  user,
  currentUserId,
  onClose,
}: {
  user: User
  currentUserId?: string
  onClose: () => void
}) {
  const isEditingSelf = currentUserId !== undefined && user.id === currentUserId
  const [displayName, setDisplayName] = React.useState(user.display_name ?? '')
  const [email, setEmail] = React.useState(user.email ?? '')
  const [role, setRole] = React.useState<Role>(user.role)
  const [status, setStatus] = React.useState<'active' | 'disabled'>(user.status)
  const [totpRequired, setTotpRequired] = React.useState(user.totp_required)
  const [confirmedSelfChange, setConfirmedSelfChange] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const invalidate = useInvalidateUsers(currentUserId)

  const isSelfDemotion = isEditingSelf && role !== 'owner' && user.role === 'owner'
  const isSelfDisabling = isEditingSelf && status === 'disabled' && user.status === 'active'
  const needsSelfConfirmation = isSelfDemotion || isSelfDisabling
  const { toast } = useToast()

  const editMutation = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH('/admin/api/v1/users/{id}', {
          params: { path: { id: user.id } },
          body: {
            display_name: displayName.trim(),
            email: email.trim(),
            role,
            status,
            totp_required: role === 'owner' ? true : totpRequired,
          },
        }),
      ),
    onSuccess: () => {
      invalidate(user.id)
      toast({ title: 'User saved' })
      onClose()
    },
    onError: (err) => {
      setError(mapUserError(err))
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (needsSelfConfirmation && !confirmedSelfChange) {
      setError('Please confirm that you understand the consequences of modifying your own account.')
      return
    }
    setError(null)
    editMutation.mutate()
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit user &ldquo;{user.username}&rdquo;</DialogTitle>
        <DialogDescription>
          Update role, status, or contact details for &ldquo;{user.username}&rdquo;.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Username</span>
            <Input value={user.username} disabled className="bg-muted/40 font-mono text-xs" />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="user-edit-role" className="text-xs font-medium text-muted-foreground">
              Role
            </label>
            <Select
              value={role}
              onValueChange={(val: Role) => {
                setRole(val)
                if (val === 'owner') setTotpRequired(true)
              }}
            >
              <SelectTrigger
                id="user-edit-role"
                className="w-full"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'user-edit-error' : undefined}
              >
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                <RoleOptions />
              </SelectContent>
            </Select>
            {role === 'user' && (
              <span className="text-xs text-muted-foreground">{USER_ROLE_HELP}</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="user-edit-status" className="text-xs font-medium text-muted-foreground">
              Status
            </label>
            <Select value={status} onValueChange={(val: 'active' | 'disabled') => setStatus(val)}>
              <SelectTrigger
                id="user-edit-status"
                className="w-full"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'user-edit-error' : undefined}
              >
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="user-edit-display-name"
              className="text-xs font-medium text-muted-foreground"
            >
              Display name
            </label>
            <Input
              id="user-edit-display-name"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'user-edit-error' : undefined}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Jane Doe"
              maxLength={128}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="user-edit-email" className="text-xs font-medium text-muted-foreground">
            Email
          </label>
          <Input
            id="user-edit-email"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'user-edit-error' : undefined}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jdoe@example.com"
          />
        </div>

        {/* TOTP Required Switch */}
        <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex flex-col gap-0.5">
            <label htmlFor="user-edit-totp-switch" className="text-xs font-medium text-foreground">
              Require two-factor authentication
            </label>
            <span className="text-xs text-muted-foreground">
              {role === 'owner'
                ? 'Mandatory for owners.'
                : 'User must enroll TOTP upon signing in.'}
            </span>
          </div>
          <Switch
            id="user-edit-totp-switch"
            checked={role === 'owner' ? true : totpRequired}
            disabled={role === 'owner'}
            onCheckedChange={setTotpRequired}
          />
        </div>

        {removesGrants(user.role, role) && (
          <p
            role="note"
            className="rounded-lg border border-status-pending/40 bg-status-pending/10 p-3 text-xs text-foreground"
          >
            Changing this role removes the devices and groups assigned to this account.
          </p>
        )}

        {/* Self-action warning alert */}
        {needsSelfConfirmation && (
          <div className="flex flex-col gap-2 rounded-lg border border-status-pending/40 bg-status-pending/10 p-3 text-xs text-foreground">
            <div className="flex items-center gap-2 font-semibold text-status-pending">
              <AlertCircleIcon className="size-4 shrink-0" />
              <span>Warning: modifying your own account</span>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              {isSelfDisabling
                ? 'Disabling your own account will immediately end your current session and sign you out.'
                : `Removing your owner role will immediately demote your account to ${role} privileges.`}
            </p>
            <label className="flex items-center gap-2 mt-1 cursor-pointer font-medium pointer-coarse:min-h-11">
              <input
                type="checkbox"
                checked={confirmedSelfChange}
                onChange={(e) => setConfirmedSelfChange(e.target.checked)}
                className="size-4 shrink-0 rounded border-border text-primary-text accent-primary focus:ring-primary"
              />
              <span>I understand and wish to proceed</span>
            </label>
          </div>
        )}

        {error && (
          <p id="user-edit-error" role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={editMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={editMutation.isPending || (needsSelfConfirmation && !confirmedSelfChange)}
          >
            {editMutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

export function UserEditDialog({ user, currentUserId, open, onOpenChange }: UserEditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="user-edit-dialog" className="sm:max-w-md">
        {open && user && (
          <EditUserForm
            user={user}
            currentUserId={currentUserId}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// -------------------------------------------------------------
// 3. UserResetTotpDialog
// -------------------------------------------------------------
export interface UserResetTotpDialogProps {
  user: User | null
  currentUserId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function ResetTotpForm({
  user,
  currentUserId,
  onClose,
}: {
  user: User
  currentUserId?: string
  onClose: () => void
}) {
  const [error, setError] = React.useState<string | null>(null)
  const invalidate = useInvalidateUsers(currentUserId)
  const { toast } = useToast()

  const resetMutation = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/admin/api/v1/users/{id}/reset-totp', {
          params: { path: { id: user.id } },
        }),
      ),
    onSuccess: () => {
      invalidate(user.id)
      toast({ title: `TOTP reset for ${user.username}` })
      onClose()
    },
    onError: (err) => {
      setError(mapUserError(err))
    },
  })

  return (
    <>
      <DialogHeader>
        <DialogTitle>Reset two-factor authentication</DialogTitle>
        <DialogDescription>
          Reset two-factor authentication for &ldquo;{user.username}&rdquo;? They will set up a new
          authenticator at their next sign-in.
        </DialogDescription>
      </DialogHeader>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={resetMutation.isPending}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => resetMutation.mutate()}
          disabled={resetMutation.isPending}
        >
          {resetMutation.isPending ? 'Resetting…' : 'Reset 2FA'}
        </Button>
      </DialogFooter>
    </>
  )
}

export function UserResetTotpDialog({
  user,
  currentUserId,
  open,
  onOpenChange,
}: UserResetTotpDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="user-reset-totp-dialog" className="sm:max-w-md">
        {open && user && (
          <ResetTotpForm
            user={user}
            currentUserId={currentUserId}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
