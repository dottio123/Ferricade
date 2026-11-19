import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { api, unwrap } from '@/api/client'
import { DeviceDetail } from '@/components/devices/device-detail'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { deviceName } from '@/lib/device'
import { queryKeys } from '@/lib/queryKeys'

// The device panel of every signed-in page: the app shell renders it, and a
// ?device=<id> search parameter (set by DeviceLink) opens it over the page.
// Closing removes both device and from while keeping the rest of the page's search.
export function DevicePanel() {
  const { device, from } = useSearch({ strict: false }) as { device?: string; from?: string }
  const navigate = useNavigate()
  const router = useRouter()
  const location = useLocation()

  const activeFrom = from && from !== device ? from : undefined
  const fromQuery = useQuery({
    queryKey: queryKeys.device(activeFrom ?? '__none__'),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/admin/api/v1/devices/{id}', {
          params: { path: { id: activeFrom! } },
          signal,
        }),
      ),
    enabled: Boolean(device && activeFrom),
  })

  const close = () => {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev }
        delete next.device
        delete next.from
        return next
      },
      replace: true,
    })
  }

  const fromName = fromQuery.data ? deviceName(fromQuery.data) : 'previous device'
  const canGoBackToFrom = Boolean(
    activeFrom && location.state.fromDeviceId === activeFrom && router.history.canGoBack(),
  )

  return (
    <Sheet open={Boolean(device)} onOpenChange={(open) => !open && close()}>
      <SheetContent
        side="right"
        className="sm:max-w-2xl p-0 overflow-y-auto"
        showCloseButton={false}
      >
        <SheetTitle className="sr-only">Device details</SheetTitle>
        {device && activeFrom && (
          <div className="border-b border-border bg-muted/30 px-6 py-2.5">
            <Link
              to="."
              search={(prev: Record<string, unknown>) => {
                const next: Record<string, unknown> = { ...prev, device: activeFrom }
                delete next.from
                return next
              }}
              state={(prev) => {
                const next = { ...prev }
                delete next.fromDeviceId
                return next
              }}
              onClick={(e) => {
                if (canGoBackToFrom) {
                  e.preventDefault()
                  router.history.back()
                }
              }}
              data-slot="device-panel-back"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors rounded-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              ← Back to {fromName}
            </Link>
          </div>
        )}
        {device && <DeviceDetail deviceId={device} onClose={close} />}
      </SheetContent>
    </Sheet>
  )
}
