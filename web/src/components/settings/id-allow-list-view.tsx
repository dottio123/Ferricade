import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { useMe } from '@/auth/session'
import { ErrorState } from '@/components/brand/error-state'
import { PageHeader } from '@/components/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { queryKeys } from '@/lib/queryKeys'
import { idAllowListQueryOptions } from '@/lib/queries'
import { IdAllowListEditor } from './id-allow-list-editor'

export function IdAllowListView() {
  const { data: me } = useMe()
  const queryClient = useQueryClient()
  const role = me?.user.role
  const editable = role === 'owner'
  const visible = role === 'owner' || role === 'admin'
  const query = useQuery({ ...idAllowListQueryOptions, enabled: visible })

  if (!visible) return null

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6 mx-auto">
      <PageHeader
        title="Global ID Allowlist"
        description="Limit which RustDesk IDs can connect to managed devices."
      />
      {query.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data ? (
        <IdAllowListEditor
          key={JSON.stringify(query.data.ids)}
          title="Global ID Allowlist"
          ids={query.data.ids}
          readOnly={!editable}
          onSave={async (ids) => {
            await unwrap(api.PUT('/admin/api/v1/settings/id-allow-list', { body: { ids } }))
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: queryKeys.settingsIDAllowList() }),
              queryClient.invalidateQueries({ queryKey: queryKeys.device() }),
            ])
          }}
        />
      ) : null}
    </div>
  )
}
