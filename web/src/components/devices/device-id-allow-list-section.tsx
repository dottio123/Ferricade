import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { useRole } from '@/auth/role'
import { ErrorState } from '@/components/brand/error-state'
import { IdAllowListEditor } from '@/components/settings/id-allow-list-editor'
import { Skeleton } from '@/components/ui/skeleton'
import { queryKeys } from '@/lib/queryKeys'

export function DeviceIDAllowListSection({
  deviceId,
  fromDeviceId,
}: {
  deviceId: string
  fromDeviceId?: string
}) {
  const role = useRole()
  const client = useQueryClient()
  const key = queryKeys.deviceIDAllowList(deviceId)
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET('/admin/api/v1/devices/{id}/id-allow-list', { params: { path: { id: deviceId } } }),
      ),
    enabled: role === 'owner' || role === 'admin',
  })
  if (role === 'user') return null
  if (query.isLoading) return <Skeleton className="h-48 w-full" />
  if (query.error) return <ErrorState error={query.error} retry={() => void query.refetch()} />
  if (!query.data) return null
  return (
    <div className="flex flex-col gap-4">
      <IdAllowListEditor
        key={JSON.stringify([query.data.ids, query.data.effective])}
        title="This device ID allow list"
        ids={query.data.ids}
        fromDeviceId={fromDeviceId}
        onSave={async (ids) => {
          await unwrap(
            api.PUT('/admin/api/v1/devices/{id}/id-allow-list', {
              params: { path: { id: deviceId } },
              body: { ids },
            }),
          )
          await client.invalidateQueries({ queryKey: key })
        }}
      />
      <IdAllowListEditor
        key={JSON.stringify(query.data.effective)}
        title="Effective ID allow list"
        ids={[]}
        readOnly
        effective={query.data.effective}
        fromDeviceId={fromDeviceId}
      />
    </div>
  )
}
