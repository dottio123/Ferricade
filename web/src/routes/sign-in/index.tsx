import { createFileRoute } from '@tanstack/react-router'
import { useEffect, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../api/client'
import { getAuthErrorMessage, useBusyRetry } from '../../auth/messages'
import { leaveSignInWhenSignedIn, validateNextSearch } from '../../auth/guard'
import { signInShown } from '../../auth/unauthorized'
import { useSignIn } from '../../auth/signIn'
import { safeNext } from '../../auth/next'
import { queryKeys } from '../../lib/queryKeys'
import { oidcErrorMessage } from '../../components/auth/oidc-messages'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'

// Step 1 of sign-in: username and password.
export const Route = createFileRoute('/sign-in/')({
  validateSearch: (search: Record<string, unknown>) => ({
    ...validateNextSearch(search),
    ...(typeof search.sso_error === 'string' ? { sso_error: search.sso_error } : {}),
  }),
  beforeLoad: ({ context, search }) => leaveSignInWhenSignedIn(context.queryClient, search.next),
  component: SignIn,
})

function SignIn() {
  const { next, sso_error } = Route.useSearch()
  const oidc = useQuery({
    queryKey: queryKeys.oidcPublic(),
    queryFn: () => unwrap(api.GET('/admin/api/v1/auth/oidc')),
  })
  // The page before this one is gone now: sign-out and the 401 handler forget
  // the session's cached data only then (src/auth/unauthorized.ts).
  useEffect(() => signInShown(), [])
  const signIn = useSignIn(next)

  const { submit: handleSignIn, retried } = useBusyRetry(
    ({ username, password }: { username: string; password: string }) => {
      signIn.mutate({ username, password })
    },
    signIn.error,
    signIn.isSuccess,
  )

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const username = String(form.get('username') ?? '').trim()
    const password = String(form.get('password') ?? '')
    if (username && password) {
      handleSignIn({ username, password })
    }
  }

  const errorMsg = signIn.error ? getAuthErrorMessage(signIn.error, 'login', retried) : null

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm border-border shadow-lg">
        <CardHeader className="pb-4 text-center">
          <p className="font-mono text-sm font-bold tracking-tight text-primary">Ferricade</p>
          <CardTitle>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Sign in</h1>
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Sign in to your Ferricade console.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sso_error && (
            <p role="alert" className="mb-4 text-center text-xs text-destructive">
              {oidcErrorMessage(sso_error, oidc.data?.display_name || undefined)}
            </p>
          )}
          {oidc.data?.enabled && (
            <>
              <a
                className="flex h-9 w-full items-center justify-center rounded-md border border-input text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                href={`/admin/api/v1/auth/oidc/start?next=${encodeURIComponent(safeNext(next))}`}
              >
                Sign in with {oidc.data.display_name}
              </a>
              <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="username" className="text-xs font-medium text-muted-foreground">
                Username
              </label>
              <Input id="username" name="username" autoComplete="username" required autoFocus />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
                Password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>

            {errorMsg && (
              <p role="alert" className="text-xs text-center text-destructive">
                {errorMsg}
              </p>
            )}

            <Button type="submit" disabled={signIn.isPending} className="w-full">
              {signIn.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
