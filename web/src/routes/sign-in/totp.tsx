import { createFileRoute } from '@tanstack/react-router'
import type { FormEvent } from 'react'
import { getAuthErrorMessage, useBusyRetry } from '../../auth/messages'
import { requireSecondFactor, validateNextSearch } from '../../auth/guard'
import { useVerifyTotp } from '../../auth/signIn'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'

// Step 2 of sign-in: the TOTP code.
export const Route = createFileRoute('/sign-in/totp')({
  validateSearch: validateNextSearch,
  beforeLoad: ({ context, search }) =>
    requireSecondFactor(context.queryClient, 'totp', search.next),
  component: Totp,
})

function Totp() {
  const { next } = Route.useSearch()
  const verify = useVerifyTotp(next)

  const { submit: handleVerify, retried } = useBusyRetry(
    (code: string) => {
      verify.mutate({ code })
    },
    verify.error,
    verify.isSuccess,
  )

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const code = String(form.get('code') ?? '').trim()
    if (code) {
      handleVerify(code)
    }
  }

  const errorMsg = verify.error ? getAuthErrorMessage(verify.error, 'totp', retried) : null

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm border-border shadow-lg">
        <CardHeader className="pb-4 text-center">
          <CardTitle>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Two-factor code</h1>
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Enter the 6-digit verification code from your authenticator app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="code" className="text-xs font-medium text-muted-foreground">
                Code
              </label>
              <Input
                id="code"
                name="code"
                placeholder="000000"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                className="font-mono text-center tracking-widest text-base"
              />
            </div>

            {errorMsg && (
              <p role="alert" className="text-xs text-center text-destructive">
                {errorMsg}
              </p>
            )}

            <Button type="submit" disabled={verify.isPending} className="w-full">
              {verify.isPending ? 'Verifying…' : 'Verify'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
