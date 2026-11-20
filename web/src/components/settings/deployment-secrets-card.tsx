import * as React from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AlertTriangleIcon, KeyRoundIcon, LockIcon, ShieldCheckIcon } from 'lucide-react'
import { Rule } from '@/components/password-rules'
import { useToast } from '@/components/ui/toast'
import { describeError } from '@/api/errors'
import type { components } from '@/api/schema'

type Profile = components['schemas']['DeploymentProfile']
type SecretState = components['schemas']['DeploymentSecretState']

interface DeploymentSecretsCardProps {
  profile: Profile
  disabled: boolean
  isGlobalAllowListEmpty: boolean
  onToggleIncludePassword: (include: boolean) => void
  onToggleIncludePIN: (include: boolean) => void
  onToggleIncludeIdAllowList: (include: boolean) => void
  onSaveSecret: (secrets: {
    fleet_password?: string | null
    unlock_pin?: string | null
  }) => Promise<void>
}

export function hasForbiddenSecretChars(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '"' || ch === '\\' || code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

export function validatePasswordRules(password: string) {
  const len = [...password].length
  const lengthMet = len >= 8 && len <= 128
  let upper = false
  let lower = false
  let digit = false
  for (const ch of password) {
    if (ch >= 'A' && ch <= 'Z') upper = true
    if (ch >= 'a' && ch <= 'z') lower = true
    if (ch >= '0' && ch <= '9') digit = true
  }
  const noForbidden = !hasForbiddenSecretChars(password)
  return {
    lengthMet,
    upperMet: upper,
    lowerMet: lower,
    digitMet: digit,
    noForbidden,
    allMet: lengthMet && upper && lower && digit && noForbidden,
  }
}

export function validatePinRules(pin: string) {
  const len = [...pin].length
  const lengthMet = len >= 4 && len <= 128
  const noForbidden = !hasForbiddenSecretChars(pin)
  return {
    lengthMet,
    noForbidden,
    allMet: lengthMet && noForbidden,
  }
}

function formatSecretStatus(secret: SecretState): string {
  if (!secret.set || !secret.set_at) return 'Not set'
  const dateStr = new Date(secret.set_at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
  const author = secret.set_by?.display_name || 'owner'
  return `Set on ${dateStr} by ${author}`
}

export function DeploymentSecretsCard({
  profile,
  disabled,
  isGlobalAllowListEmpty,
  onToggleIncludePassword,
  onToggleIncludePIN,
  onToggleIncludeIdAllowList,
  onSaveSecret,
}: DeploymentSecretsCardProps) {
  const { toast } = useToast()

  // Password dialog state
  const [passwordDialogOpen, setPasswordDialogOpen] = React.useState(false)
  const [passwordVal, setPasswordVal] = React.useState('')
  const [passwordConfirm, setPasswordConfirm] = React.useState('')
  const [passwordError, setPasswordError] = React.useState<string | null>(null)
  const [passwordSubmitting, setPasswordSubmitting] = React.useState(false)

  // PIN dialog state
  const [pinDialogOpen, setPinDialogOpen] = React.useState(false)
  const [pinVal, setPinVal] = React.useState('')
  const [pinConfirm, setPinConfirm] = React.useState('')
  const [pinError, setPinError] = React.useState<string | null>(null)
  const [pinSubmitting, setPinSubmitting] = React.useState(false)

  const pwRules = validatePasswordRules(passwordVal)
  const pinRules = validatePinRules(pinVal)

  const handleOpenPasswordDialog = () => {
    setPasswordVal('')
    setPasswordConfirm('')
    setPasswordError(null)
    setPasswordDialogOpen(true)
  }

  const handleSavePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPasswordError(null)
    if (!pwRules.allMet) {
      setPasswordError('Please meet all password requirements before saving.')
      return
    }
    if (passwordVal !== passwordConfirm) {
      setPasswordError('Passwords do not match.')
      return
    }
    try {
      setPasswordSubmitting(true)
      await onSaveSecret({ fleet_password: passwordVal })
      setPasswordDialogOpen(false)
      setPasswordVal('')
      setPasswordConfirm('')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save password'
      setPasswordError(msg)
    } finally {
      setPasswordSubmitting(false)
    }
  }

  const handleRemovePassword = async () => {
    try {
      await onSaveSecret({ fleet_password: null })
    } catch (err) {
      toast({
        title: 'Failed to remove fleet password',
        description: describeError(err).message,
        variant: 'destructive',
      })
    }
  }

  const handleOpenPinDialog = () => {
    setPinVal('')
    setPinConfirm('')
    setPinError(null)
    setPinDialogOpen(true)
  }

  const handleSavePin = async (e: React.FormEvent) => {
    e.preventDefault()
    setPinError(null)
    if (!pinRules.allMet) {
      setPinError('Please meet all PIN requirements before saving.')
      return
    }
    if (pinVal !== pinConfirm) {
      setPinError('PINs do not match.')
      return
    }
    try {
      setPinSubmitting(true)
      await onSaveSecret({ unlock_pin: pinVal })
      setPinDialogOpen(false)
      setPinVal('')
      setPinConfirm('')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save PIN'
      setPinError(msg)
    } finally {
      setPinSubmitting(false)
    }
  }

  const handleRemovePin = async () => {
    try {
      await onSaveSecret({ unlock_pin: null })
    } catch (err) {
      toast({
        title: 'Failed to remove unlock PIN',
        description: describeError(err).message,
        variant: 'destructive',
      })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Secrets and security</CardTitle>
        <CardDescription className="text-xs">
          Configure unattended access passwords and client settings lock PINs.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Fleet password section */}
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4 bg-card">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <div className="flex size-7 items-center justify-center rounded-md bg-muted text-foreground">
                <KeyRoundIcon className="size-4" />
              </div>
              <div>
                <span className="text-sm font-medium text-foreground">Fleet password</span>
                <p className="text-xs text-muted-foreground">
                  The permanent password used for incoming remote connections.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label
                htmlFor="include-password-switch"
                className="text-xs text-muted-foreground hidden sm:inline"
              >
                Include in script
              </label>
              <Switch
                id="include-password-switch"
                checked={profile.include_password}
                onCheckedChange={onToggleIncludePassword}
                disabled={disabled}
                aria-label="Include fleet password in script"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground font-medium">Status:</span>
              <span
                className={
                  profile.password.set ? 'font-medium text-status-online' : 'text-muted-foreground'
                }
              >
                {formatSecretStatus(profile.password)}
              </span>
            </div>

            {!disabled && (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleOpenPasswordDialog}
                >
                  {profile.password.set ? 'Change password' : 'Set fleet password'}
                </Button>
                {profile.password.set && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={handleRemovePassword}
                  >
                    Remove fleet password
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Settings unlock PIN section */}
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4 bg-card">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <div className="flex size-7 items-center justify-center rounded-md bg-muted text-foreground">
                <LockIcon className="size-4" />
              </div>
              <div>
                <span className="text-sm font-medium text-foreground">Settings unlock PIN</span>
                <p className="text-xs text-muted-foreground">
                  Locks the client&apos;s Security and Network settings for local users.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label
                htmlFor="include-pin-switch"
                className="text-xs text-muted-foreground hidden sm:inline"
              >
                Include in script
              </label>
              <Switch
                id="include-pin-switch"
                checked={profile.include_unlock_pin}
                onCheckedChange={onToggleIncludePIN}
                disabled={disabled}
                aria-label="Include unlock PIN in script"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground font-medium">Status:</span>
              <span
                className={
                  profile.unlock_pin.set
                    ? 'font-medium text-status-online'
                    : 'text-muted-foreground'
                }
              >
                {formatSecretStatus(profile.unlock_pin)}
              </span>
            </div>

            {!disabled && (
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={handleOpenPinDialog}>
                  {profile.unlock_pin.set ? 'Change PIN' : 'Set unlock PIN'}
                </Button>
                {profile.unlock_pin.set && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={handleRemovePin}
                  >
                    Remove unlock PIN
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Global ID allow list section */}
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4 bg-card">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <div className="flex size-7 items-center justify-center rounded-md bg-muted text-foreground">
                <ShieldCheckIcon className="size-4" />
              </div>
              <div>
                <label
                  htmlFor="include-id-allow-list-switch"
                  className="text-sm font-medium text-foreground cursor-pointer"
                >
                  Include the Global ID Allowlist
                </label>
                <p id="include-id-allow-list-description" className="text-xs text-muted-foreground">
                  Sets the device&apos;s ID allow list to the Global ID Allowlist when the script
                  runs. The list is copied when you download the script; download again after
                  changing it.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                id="include-id-allow-list-switch"
                checked={profile.include_id_allow_list}
                onCheckedChange={onToggleIncludeIdAllowList}
                disabled={disabled}
                aria-describedby={
                  profile.include_id_allow_list
                    ? 'include-id-allow-list-description include-id-allow-list-warning'
                    : 'include-id-allow-list-description'
                }
              />
            </div>
          </div>

          {profile.include_id_allow_list && (
            <div
              id="include-id-allow-list-warning"
              data-slot="id-allow-list-warning"
              className="flex items-start gap-2.5 rounded-md border border-status-alert/30 bg-status-alert/10 p-3 text-xs text-foreground leading-relaxed"
            >
              <AlertTriangleIcon
                className="size-4 text-status-alert shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <span>
                New devices will refuse every RustDesk ID not on the Global ID Allowlist until they
                are approved with policy push on. Add your technicians&apos; IDs first.
                {isGlobalAllowListEmpty &&
                  ' The Global ID Allowlist is empty, so the script sets nothing.'}
              </span>
            </div>
          )}
        </div>
      </CardContent>

      <SecretDialog
        kind="password"
        open={passwordDialogOpen}
        onOpenChange={setPasswordDialogOpen}
        isSet={profile.password.set}
        value={passwordVal}
        onValueChange={setPasswordVal}
        confirmation={passwordConfirm}
        onConfirmationChange={setPasswordConfirm}
        error={passwordError}
        submitting={passwordSubmitting}
        rules={pwRules}
        onSubmit={handleSavePassword}
      />
      <SecretDialog
        kind="pin"
        open={pinDialogOpen}
        onOpenChange={setPinDialogOpen}
        isSet={profile.unlock_pin.set}
        value={pinVal}
        onValueChange={setPinVal}
        confirmation={pinConfirm}
        onConfirmationChange={setPinConfirm}
        error={pinError}
        submitting={pinSubmitting}
        rules={pinRules}
        onSubmit={handleSavePin}
      />
    </Card>
  )
}

type SecretDialogProps = {
  kind: 'password' | 'pin'
  open: boolean
  onOpenChange: (open: boolean) => void
  isSet: boolean
  value: string
  onValueChange: (value: string) => void
  confirmation: string
  onConfirmationChange: (value: string) => void
  error: string | null
  submitting: boolean
  rules: ReturnType<typeof validatePasswordRules> | ReturnType<typeof validatePinRules>
  onSubmit: (event: React.FormEvent) => void
}

function SecretDialog({
  kind,
  open,
  onOpenChange,
  isSet,
  value,
  onValueChange,
  confirmation,
  onConfirmationChange,
  error,
  submitting,
  rules,
  onSubmit,
}: SecretDialogProps) {
  const password = kind === 'password'
  const title = password
    ? isSet
      ? 'Change fleet password'
      : 'Set fleet password'
    : isSet
      ? 'Change unlock PIN'
      : 'Set unlock PIN'
  const label = password ? 'Fleet password' : 'Unlock PIN'
  const inputId = password ? 'fleet-password-input' : 'unlock-pin-input'
  const confirmationId = password ? 'fleet-password-confirm' : 'unlock-pin-confirm'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="text-xs">
              {password
                ? 'The password is sealed at rest, never shown again, and only inserted into downloaded deployment scripts.'
                : "Locks the client's Security and Network settings for local users."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
                {label}
              </label>
              <Input
                id={inputId}
                type="password"
                autoComplete="new-password"
                value={value}
                onChange={(event) => onValueChange(event.target.value)}
                placeholder={`Enter ${password ? '8' : '4'}-128 characters`}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={confirmationId} className="text-xs font-medium text-muted-foreground">
                Confirm {password ? 'password' : 'PIN'}
              </label>
              <Input
                id={confirmationId}
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => onConfirmationChange(event.target.value)}
                placeholder="Repeat password"
                required
              />
            </div>
            <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-3 text-xs">
              <span className="font-semibold text-foreground mb-1">
                {password ? 'Password' : 'PIN'} rules:
              </span>
              <Rule
                met={rules.lengthMet}
                label={`${password ? '8' : '4'}–128 characters (${[...value].length}/${password ? '8' : '4'} min)`}
              />
              {password && 'upperMet' in rules && (
                <Rule met={rules.upperMet} label="At least one uppercase letter (A–Z)" />
              )}
              {password && 'lowerMet' in rules && (
                <Rule met={rules.lowerMet} label="At least one lowercase letter (a–z)" />
              )}
              {password && 'digitMet' in rules && (
                <Rule met={rules.digitMet} label="At least one digit (0–9)" />
              )}
              <Rule
                met={rules.noForbidden}
                label={'No quotes ("), backslashes (\\), or control characters'}
              />
              {password && 'upperMet' in rules && confirmation.length > 0 && (
                <Rule met={value === confirmation} label="Passwords match" />
              )}
              {!password && confirmation.length > 0 && (
                <Rule met={value === confirmation} label="PINs match" />
              )}
            </div>
            {error && (
              <div role="alert" className="text-xs font-medium text-destructive">
                {error}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !rules.allMet || !value}>
              {submitting ? 'Saving…' : `Save ${password ? 'password' : 'PIN'}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
