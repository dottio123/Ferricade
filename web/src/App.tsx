import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { RouterProvider, useRouterState } from '@tanstack/react-router'
import { FerricadeLoader } from '@/components/motion/ferricade-loader'
import { MutationErrorToasts } from '@/components/mutation-error-toasts'
import { ToasterProvider } from '@/components/ui/toast'
import { OverlayFocusProvider } from '@/components/ui/use-overlay-focus'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AppRouter } from './router'

function InitialBootLoader({ router }: { router: AppRouter }) {
  const isBooting = useRouterState({
    router,
    select: (state) => state.resolvedLocation === undefined,
  })
  if (!isBooting) return null
  return <FerricadeLoader fullPage />
}

export function App({ router, queryClient }: { router: AppRouter; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToasterProvider>
        <MutationErrorToasts />
        <TooltipProvider delayDuration={150}>
          <OverlayFocusProvider>
            <RouterProvider router={router} />
            <InitialBootLoader router={router} />
          </OverlayFocusProvider>
        </TooltipProvider>
      </ToasterProvider>
    </QueryClientProvider>
  )
}
