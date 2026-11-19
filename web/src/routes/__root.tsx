// The root of every route: setup detection, and the pages for an unknown path
// and for an error. Placeholders, unstyled; the design comes in Part B.
import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  Outlet,
  useRouter,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import { requireSetupState } from '../auth/guard'

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: ({ context, location }) => requireSetupState(context.queryClient, location),
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: ErrorPage,
})

function NotFound() {
  return (
    <main>
      <h1>Page not found</h1>
    </main>
  )
}

function ErrorPage({ error }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <main>
      <h1>Something went wrong</h1>
      <p role="alert">{error instanceof Error ? error.message : String(error)}</p>
      <button type="button" onClick={() => void router.invalidate()}>
        Try again
      </button>
    </main>
  )
}
