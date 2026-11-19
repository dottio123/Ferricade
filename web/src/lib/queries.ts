import { queryOptions } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { queryKeys } from './queryKeys'

export const summaryQueryOptions = queryOptions({
  queryKey: queryKeys.summary(),
  queryFn: ({ signal }) => unwrap(api.GET('/admin/api/v1/stats/summary', { signal })),
})

export const groupsQueryOptions = queryOptions({
  queryKey: queryKeys.groups(),
  queryFn: ({ signal }) => unwrap(api.GET('/admin/api/v1/groups', { signal })),
})

export const preferencesQueryOptions = queryOptions({
  queryKey: queryKeys.preferences(),
  queryFn: ({ signal }) => unwrap(api.GET('/admin/api/v1/me/preferences', { signal })),
})

export const idAllowListQueryOptions = queryOptions({
  queryKey: queryKeys.settingsIDAllowList(),
  queryFn: () => unwrap(api.GET('/admin/api/v1/settings/id-allow-list')),
})
