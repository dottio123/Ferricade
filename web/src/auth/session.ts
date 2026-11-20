import { queryOptions, useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../api/client'
import type { paths } from '../api/schema'
import { queryKeys } from '../lib/queryKeys'
import { isSignInPending } from './unauthorized'

/** GET /auth/me: the signed-in user and the session's state. */
export type Me =
  paths['/admin/api/v1/auth/me']['get']['responses'][200]['content']['application/json']

export const meQuery = queryOptions({
  queryKey: queryKeys.me(),
  queryFn: ({ signal }) => unwrap(api.GET('/admin/api/v1/auth/me', { signal })),
  // Route guards still fetch imperatively; only the old page's observers pause.
  enabled: () => !isSignInPending(),
})

/** GET /setup/status. It changes only when the wizard completes (which updates it). */
export const setupStatusQuery = queryOptions({
  queryKey: queryKeys.setupStatus(),
  queryFn: ({ signal }) => unwrap(api.GET('/setup/status', { signal })),
  staleTime: Infinity,
})

/** The signed-in user. Under the app shell's guard it is always loaded. */
export function useMe() {
  return useQuery(meQuery)
}

/** Whether GET /setup/status reported plain HTTP (ALLOW_HTTP). */
export function usePlainHttp(): boolean {
  const { data } = useQuery(setupStatusQuery)
  return data?.plain_http === true
}
