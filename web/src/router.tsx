import type { QueryClient } from '@tanstack/react-query'
import { createRouter, useRouterState, type RouterHistory } from '@tanstack/react-router'
import { FerricadeLoader } from './components/motion/ferricade-loader'
import { routeTree } from './routeTree.gen'

function RoutePendingLoader() {
  const hasResolved = useRouterState({ select: (s) => s.resolvedLocation !== undefined })
  if (!hasResolved) return null
  return <FerricadeLoader />
}

/** The app's router. Tests pass a memory history. */
export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    ...(history ? { history } : {}),
    defaultPendingComponent: RoutePendingLoader,
    defaultPendingMs: 200,
    defaultPendingMinMs: 250,
    // Loaders and guards read through TanStack Query, which does the caching.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}
