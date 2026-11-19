import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { api, unwrap } from '@/api/client'
import { ApiError } from '@/api/errors'
import { getAuthErrorMessage, useBusyRetry } from '@/auth/messages'
import { safeNext } from '@/auth/next'
import { CopyField } from '@/components/brand/copy-field'
import { TotpQr } from '@/components/brand/totp-qr'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { queryKeys } from '@/lib/queryKeys'
import { cn } from '@/lib/utils'

export interface TotpEnrollmentProps {
  next?: string
  onSuccess?: () => void
  requireCurrentPassword?: boolean
  requestSecret?: (currentPassword?: string) => Promise<{ secret: string; otpauth_url: string }>
  verifyCode?: (code: string) => Promise<unknown>
  onErrorSecret?: (err: unknown) => void
  onErrorVerify?: (err: unknown) => void
  className?: string
}

export function TotpEnrollment({
  next,
  onSuccess,
  requireCurrentPassword = false,
  requestSecret,
  verifyCode,
  onErrorSecret,
  onErrorVerify,
  className,
}: TotpEnrollmentProps) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [currentPassword, setCurrentPassword] = React.useState('')

  // Issues a fresh secret held for 10 min
  const enroll = useMutation({
    mutationFn: (password?: string) =>
      requestSecret
        ? requestSecret(password)
        : unwrap(
            api.POST('/admin/api/v1/auth/totp/enroll', {
              body: password ? { current_password: password } : {},
            }),
          ),
    onError: (err) => {
      onErrorSecret?.(err)
    },
  })

  // Trigger enrollment once per mount with ref guard against dev StrictMode double-invocations
  const initiatedRef = React.useRef(false)
  React.useEffect(() => {
    if (!requireCurrentPassword && !initiatedRef.current) {
      initiatedRef.current = true
      enroll.mutate(undefined)
    }
  }, [enroll, requireCurrentPassword])

  // Confirms the secret
  const verify = useMutation({
    mutationFn: (code: string) =>
      verifyCode
        ? verifyCode(code)
        : unwrap(api.POST('/admin/api/v1/auth/totp/enroll/verify', { body: { code } })),
    onSuccess: async () => {
      if (onSuccess) {
        onSuccess()
      } else {
        queryClient.removeQueries({ queryKey: queryKeys.me() })
        await navigate({ href: safeNext(next), replace: true })
      }
    },
    onError: (err) => {
      onErrorVerify?.(err)
    },
  })

  const { submit: handleVerify, retried } = useBusyRetry(
    (code: string) => {
      verify.mutate(code)
    },
    verify.error,
    verify.isSuccess,
  )

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const code = String(form.get('code') ?? '').trim()
    if (code) {
      handleVerify(code)
    }
  }

  const isExpired =
    verify.error instanceof ApiError &&
    (verify.error.status === 409 || verify.error.code === 'incomplete')

  if (requireCurrentPassword && !enroll.data) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          enroll.mutate(currentPassword)
        }}
        className={cn('flex flex-col gap-4', className)}
      >
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="totp-enroll-current-password"
            className="text-xs font-medium text-muted-foreground"
          >
            Current password
          </label>
          <Input
            id="totp-enroll-current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>
        {enroll.error && (
          <p role="alert" className="text-xs text-center text-destructive">
            {getAuthErrorMessage(enroll.error, 'enroll')}
          </p>
        )}
        <Button type="submit" disabled={enroll.isPending} className="w-full">
          {enroll.isPending ? 'Checking…' : 'Continue'}
        </Button>
      </form>
    )
  }

  if (enroll.isPending && !enroll.data) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-3 py-8', className)}>
        <p className="text-sm text-muted-foreground animate-pulse">Generating two-factor key…</p>
      </div>
    )
  }

  if (enroll.isError && !enroll.data) {
    return (
      <div className={cn('flex flex-col items-center gap-4 py-6 text-center', className)}>
        <p role="alert" className="text-sm text-destructive">
          {getAuthErrorMessage(enroll.error, 'enroll')}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => enroll.mutate()}>
          Try again
        </Button>
      </div>
    )
  }

  const data = enroll.data

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      {data && (
        <>
          <div className="flex flex-col items-center gap-3 text-center">
            <TotpQr otpauthUrl={data.otpauth_url} />
            <p className="text-xs text-muted-foreground">
              Scan with Google Authenticator, 1Password, Bitwarden, or your preferred authenticator
              app.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <CopyField value={data.secret} label="Secret key (if you cannot scan)" />
          </div>
        </>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="totp-enroll-code" className="text-xs font-medium text-muted-foreground">
            Verification code
          </label>
          <Input
            id="totp-enroll-code"
            ref={inputRef}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="123456"
            required
            autoFocus
            className="font-mono text-center tracking-widest text-base"
          />
        </div>

        {isExpired ? (
          <div className="flex flex-col gap-2 rounded-md bg-destructive/10 p-3 text-center">
            <p role="alert" className="text-xs font-medium text-destructive">
              That setup code expired.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                verify.reset()
                enroll.mutate()
              }}
              className="w-full text-xs"
            >
              Get a new code
            </Button>
          </div>
        ) : verify.error ? (
          <p role="alert" className="text-xs text-center text-destructive">
            {getAuthErrorMessage(verify.error, 'enroll', retried)}
          </p>
        ) : null}

        <Button type="submit" disabled={verify.isPending || enroll.isPending} className="w-full">
          {verify.isPending ? 'Verifying…' : 'Verify and continue'}
        </Button>
      </form>
    </div>
  )
}
