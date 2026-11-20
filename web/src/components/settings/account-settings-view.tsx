import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import { useMe } from '@/auth/session'
import { TotpEnrollment } from '@/components/auth/totp-enrollment'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/page-header'
import { queryKeys } from '@/lib/queryKeys'
import { KeyRoundIcon, ShieldCheckIcon } from 'lucide-react'
import { AccountNavTabs } from '@/components/account/account-nav-tabs'
import { PasswordRules, passwordRulesMet } from '@/components/password-rules'

export function AccountSettingsView() {
  const { data: me } = useMe()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const user = me?.user

  // --- Password Change State ---
  const [currentPassword, setCurrentPassword] = React.useState('')
  const [newPassword, setNewPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')
  const [passwordError, setPasswordError] = React.useState<string | null>(null)
  const [weakPasswordMessage, setWeakPasswordMessage] = React.useState<string | null>(null)
  const [passwordSuccess, setPasswordSuccess] = React.useState(false)

  // Live password checklist
  const isPasswordValid =
    passwordRulesMet(newPassword, user?.username ?? '', confirmPassword) &&
    currentPassword.length > 0

  const passwordMutation = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/admin/api/v1/auth/password', {
          body: {
            current_password: currentPassword,
            new_password: newPassword,
          },
        }),
      ),
    onSuccess: () => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordError(null)
      setWeakPasswordMessage(null)
      setPasswordSuccess(true)
      toast({ title: 'Password updated successfully' })
    },
    onError: (err) => {
      const { code, message } = describeError(err)
      if (code === 'forbidden') {
        setPasswordError('Current password incorrect.')
      } else if (code === 'rate_limited') {
        setPasswordError('Too many attempts. Please try again later.')
      } else if (code === 'weak_password') {
        setWeakPasswordMessage(message)
      } else {
        setPasswordError(message)
      }
    },
  })

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isPasswordValid) return
    setPasswordError(null)
    setWeakPasswordMessage(null)
    setPasswordSuccess(false)
    passwordMutation.mutate()
  }

  // --- TOTP Re-enrollment State ---
  const [isEnrollingTotp, setIsEnrollingTotp] = React.useState(false)

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <PageHeader
        title="Account"
        description={`Manage authentication credentials and two-factor security for ${user?.display_name || user?.username || ''}.`}
      />

      <AccountNavTabs active="account" />

      {/* Profile Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">User profile</CardTitle>
          <CardDescription className="text-xs">Your signed-in account details.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 text-xs">
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground font-medium">Username</span>
              <span className="font-mono text-foreground font-semibold">{user?.username}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground font-medium">Role</span>
              <Badge
                variant={user?.role === 'owner' ? 'default' : 'secondary'}
                className="w-fit capitalize"
              >
                {user?.role}
              </Badge>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground font-medium">Display name</span>
              <span className="text-foreground">{user?.display_name || '—'}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground font-medium">Email</span>
              <span className="text-foreground">{user?.email || '—'}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Change Password */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Change password</CardTitle>
          <CardDescription className="text-xs">
            Update your account password. Signing out other active sessions will occur
            automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="account-current-password"
                className="text-xs font-medium text-muted-foreground"
              >
                Current password
              </label>
              <Input
                id="account-current-password"
                aria-invalid={Boolean(passwordError)}
                aria-describedby={passwordError ? 'account-password-error' : undefined}
                type="password"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value)
                  setPasswordSuccess(false)
                }}
                autoComplete="current-password"
                required
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="account-new-password"
                  className="text-xs font-medium text-muted-foreground"
                >
                  New password
                </label>
                <Input
                  id="account-new-password"
                  aria-invalid={Boolean(passwordError)}
                  aria-describedby={`account-password-rules${passwordError ? ' account-password-error' : ''}`}
                  type="password"
                  maxLength={256}
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value)
                    setWeakPasswordMessage(null)
                    setPasswordError(null)
                    setPasswordSuccess(false)
                  }}
                  autoComplete="new-password"
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="account-confirm-password"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Confirm new password
                </label>
                <Input
                  id="account-confirm-password"
                  aria-invalid={Boolean(passwordError)}
                  aria-describedby={passwordError ? 'account-password-error' : undefined}
                  type="password"
                  maxLength={256}
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value)
                    setPasswordSuccess(false)
                  }}
                  autoComplete="new-password"
                  required
                />
              </div>
            </div>

            <PasswordRules
              id="account-password-rules"
              password={newPassword}
              username={user?.username ?? ''}
              confirmation={confirmPassword}
              weakPasswordMessage={weakPasswordMessage}
            />

            {passwordError && (
              <p id="account-password-error" role="alert" className="text-xs text-destructive">
                {passwordError}
              </p>
            )}

            {passwordSuccess && (
              <p className="text-xs text-status-online font-medium">
                Password updated successfully.
              </p>
            )}

            <div className="flex justify-end pt-2">
              <Button type="submit" disabled={!isPasswordValid || passwordMutation.isPending}>
                {passwordMutation.isPending ? 'Updating…' : 'Update password'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Two-factor authentication (TOTP) */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-sm font-semibold">
              Two-factor authentication (TOTP)
            </CardTitle>
            <CardDescription className="text-xs">
              Secure your login with a time-based one-time password authenticator.
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-xs text-status-online border-status-online/30">
            Enrolled
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!isEnrollingTotp ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary-text">
                  <ShieldCheckIcon className="size-5" />
                </div>
                <div className="flex flex-col">
                  <span className="text-xs font-medium text-foreground">Authenticator app</span>
                  <span className="text-xs text-muted-foreground">
                    Generate verification codes with Google Authenticator, 1Password, or similar.
                  </span>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsEnrollingTotp(true)}
                className="w-full shrink-0 gap-1.5 sm:w-auto"
              >
                <KeyRoundIcon className="size-3.5" />
                <span>Re-enroll authenticator</span>
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between pb-2 border-b border-border">
                <span className="text-xs font-semibold text-foreground">
                  Scan QR code with your authenticator app
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsEnrollingTotp(false)}
                  className="h-7 text-xs"
                >
                  Cancel
                </Button>
              </div>

              <TotpEnrollment
                requireCurrentPassword
                onSuccess={() => {
                  setIsEnrollingTotp(false)
                  void queryClient.invalidateQueries({ queryKey: queryKeys.me() })
                  toast({ title: 'Two-factor authentication re-enrolled successfully' })
                }}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
