import { createFileRoute } from '@tanstack/react-router'
import { requireSecondFactor, validateNextSearch } from '../auth/guard'
import { TotpEnrollment } from '../components/auth/totp-enrollment'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'

// Forced TOTP enrollment for a user with totp_required and no TOTP yet.
export const Route = createFileRoute('/enroll-totp')({
  validateSearch: validateNextSearch,
  beforeLoad: ({ context, search }) =>
    requireSecondFactor(context.queryClient, 'enroll', search.next),
  component: EnrollTotpPage,
})

function EnrollTotpPage() {
  const { next } = Route.useSearch()

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md border-border shadow-lg">
        <CardHeader className="pb-4 text-center">
          <CardTitle>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Set up two-factor authentication
            </h1>
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Your account requires a two-factor authentication app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TotpEnrollment next={next} />
        </CardContent>
      </Card>
    </main>
  )
}
