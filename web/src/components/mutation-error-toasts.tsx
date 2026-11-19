// A failed action should never be silent. A mutation opts in with
// `meta: { errorTitle }` and its failure becomes a toast with that title and
// describeError's message. Forms that show their error inline leave it out.
import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { ApiError, describeError } from '@/api/errors'
import { useToast } from '@/components/ui/toast'

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** Toast title when the mutation fails, e.g. "Could not approve the device". */
      errorTitle?: string
    }
  }
}

// These answers already take the user to sign-in or the second-factor step
// (src/auth/unauthorized.ts); a toast on top would only confuse.
function leadsElsewhere(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.status === 401) return true
  return (
    error.status === 403 &&
    (error.code === 'csrf' ||
      error.code === 'mfa_required' ||
      error.code === 'totp_enroll_required')
  )
}

/** Mount once inside QueryClientProvider and ToasterProvider. */
export function MutationErrorToasts(): null {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  React.useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'error') return
        const title = event.mutation.meta?.errorTitle
        if (!title || leadsElsewhere(event.action.error)) return
        toast({
          title,
          description: describeError(event.action.error).message,
          variant: 'destructive',
        })
      }),
    [queryClient, toast],
  )
  return null
}
