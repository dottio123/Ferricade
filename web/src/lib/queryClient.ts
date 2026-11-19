import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '../api/errors'

/**
 * The app's QueryClient. Live updates (src/live) invalidate queries as the data
 * changes, so data counts as fresh for 30 s. A 4xx is an answer, not a glitch:
 * it is not retried (a 401 has already sent the user to sign-in).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failures, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
          return failures < 2
        },
      },
      mutations: { retry: false },
    },
  })
}
