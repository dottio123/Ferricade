import { createFileRoute } from '@tanstack/react-router'
import { DeviceDetail } from '@/components/devices/device-detail'
import { PageHeader } from '@/components/page-header'

export const Route = createFileRoute('/_app/devices/$id')({
  component: DevicePage,
})

function DevicePage() {
  const { id } = Route.useParams()

  return (
    <div className="flex flex-col gap-6 w-full p-6">
      <PageHeader title="Device" backLink={{ to: '/devices', label: 'Devices' }} />
      <div className="rounded-lg border border-border bg-card">
        <DeviceDetail deviceId={id} />
      </div>
    </div>
  )
}
