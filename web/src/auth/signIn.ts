// The sign-in steps' actions. After each step the app goes to ?next= (when
// safe) and the guard there decides what comes next: the TOTP step,
// enrollment, or the page itself.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { api, unwrap } from '../api/client'
import type { paths } from '../api/schema'
import { queryKeys } from '../lib/queryKeys'
import { resumeLive, suspendLive } from '../live/connection'
import { safeNext } from './next'
import { forgetSessionData, whenSignInShows } from './unauthorized'

type Json<P extends keyof paths> = paths[P] extends {
  post: { requestBody: { content: { 'application/json': infer B } } }
}
  ? B
  : never

/**
 * After a step: the session changed, so the guard must read it again. A new
 * sign-in may be another user on the same tab: everything the previous session
 * cached is forgotten, as after a 401.
 */
function useContinue(next: string | undefined, step: 'sign-in' | 'totp') {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return async () => {
    if (step === 'sign-in') forgetSessionData(queryClient)
    else queryClient.removeQueries({ queryKey: queryKeys.me() })
    await navigate({ href: safeNext(next), replace: true })
  }
}

/** Step 1: username and password (POST /auth/login). */
export function useSignIn(next: string | undefined) {
  const onSuccess = useContinue(next, 'sign-in')
  return useMutation({
    mutationFn: (body: Json<'/admin/api/v1/auth/login'>) =>
      unwrap(api.POST('/admin/api/v1/auth/login', { body })),
    onSuccess,
  })
}

/** Step 2: the TOTP code (POST /auth/totp). */
export function useVerifyTotp(next: string | undefined) {
  const onSuccess = useContinue(next, 'totp')
  return useMutation({
    mutationFn: (body: Json<'/admin/api/v1/auth/totp'>) =>
      unwrap(api.POST('/admin/api/v1/auth/totp', { body })),
    onSuccess,
  })
}

/** Signs out (POST /auth/logout), forgets the session's data and shows sign-in. */
export function useSignOut() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    // The session ends on the server while this page is still on screen: a
    // live event's refetch then would answer 401. The stream closes with the
    // shell once sign-in shows; it reopens only if the logout fails.
    onMutate: suspendLive,
    onError: resumeLive,
    mutationFn: () => unwrap(api.POST('/admin/api/v1/auth/logout')),
    onSuccess: async () => {
      // As after a 401: the session first, or /sign-in would read the cached
      // one and send the user on to "/"; the rest once sign-in shows, so the
      // page still on screen does not fetch it again.
      queryClient.removeQueries({ queryKey: queryKeys.me() })
      void whenSignInShows().then(() => forgetSessionData(queryClient))
      await navigate({ to: '/sign-in', replace: true })
    },
  })
}
