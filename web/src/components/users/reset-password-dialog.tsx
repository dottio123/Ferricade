import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
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
import { useToast } from '@/components/ui/toast'
import { PasswordRules, passwordRulesMet } from '@/components/password-rules'
import { queryKeys } from '@/lib/queryKeys'
import type { User } from '@/features/audit/actor'

function ResetPasswordForm({ user, onClose }: { user: User; onClose: () => void }) {
  const [password, setPassword] = React.useState('')
  const [confirmation, setConfirmation] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [weakPasswordMessage, setWeakPasswordMessage] = React.useState<string | null>(null)
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const valid = passwordRulesMet(password, user.username, confirmation)

  const mutation = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/admin/api/v1/users/{id}/password', {
          params: { path: { id: user.id } },
          body: { password },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all() })
      toast({ title: `Password reset for ${user.username}` })
      onClose()
    },
    onError: (err) => {
      const { code, message } = describeError(err)
      if (code === 'weak_password') setWeakPasswordMessage(message)
      else setError(message)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setError(null)
    setWeakPasswordMessage(null)
    mutation.mutate()
  }

  const changed = () => {
    setWeakPasswordMessage(null)
    setError(null)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Reset password for &ldquo;{user.username}&rdquo;</DialogTitle>
        <DialogDescription>
          Sets a new password and signs this account out everywhere. Tell them the new password
          yourself.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="user-reset-password"
            className="text-xs font-medium text-muted-foreground"
          >
            New password
          </label>
          <Input
            id="user-reset-password"
            type="password"
            maxLength={256}
            autoComplete="new-password"
            autoFocus
            aria-invalid={Boolean(error || weakPasswordMessage)}
            aria-describedby={`user-reset-password-rules${error ? ' user-reset-password-error' : ''}`}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              changed()
            }}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="user-reset-password-confirm"
            className="text-xs font-medium text-muted-foreground"
          >
            Confirm new password
          </label>
          <Input
            id="user-reset-password-confirm"
            type="password"
            maxLength={256}
            autoComplete="new-password"
            aria-invalid={Boolean(error || weakPasswordMessage)}
            aria-describedby={`user-reset-password-rules${error ? ' user-reset-password-error' : ''}`}
            value={confirmation}
            onChange={(e) => {
              setConfirmation(e.target.value)
              changed()
            }}
            required
          />
          <PasswordRules
            id="user-reset-password-rules"
            password={password}
            username={user.username}
            confirmation={confirmation}
            usernameWording="the"
            weakPasswordMessage={weakPasswordMessage}
          />
        </div>

        {error && (
          <p id="user-reset-password-error" role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

export function UserResetPasswordDialog({
  user,
  open,
  onOpenChange,
}: {
  user: User | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="user-reset-password-dialog" className="sm:max-w-md">
        {open && user && <ResetPasswordForm user={user} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}
