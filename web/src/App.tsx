import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { MutationErrorToasts } from '@/components/mutation-error-toasts'
import { ToasterProvider } from '@/components/ui/toast'
import { OverlayFocusProvider } from '@/components/ui/use-overlay-focus'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AppRouter } from './router'

export function App({ router, queryClient }: { router: AppRouter; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToasterProvider>
        <MutationErrorToasts />
        <TooltipProvider delayDuration={150}>
          <OverlayFocusProvider>
            <RouterProvider router={router} />
          </OverlayFocusProvider>
        </TooltipProvider>
      </ToasterProvider>
    </QueryClientProvider>
  )
}
