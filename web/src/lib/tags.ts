import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import { queryKeys } from '@/lib/queryKeys'

export type Tag = components['schemas']['Tag']

export interface TagsResponse {
  items: Tag[]
  next_cursor: string
}

/**
 * Loads all pages of tags by following next_cursor with limit 200.
 */
export async function fetchAllTags(signal?: AbortSignal): Promise<Tag[]> {
  const all: Tag[] = []
  let cursor: string | undefined = undefined
  while (true) {
    const res: TagsResponse = await unwrap<TagsResponse>(
      api.GET('/admin/api/v1/tags', {
        params: {
          query: {
            limit: 200,
            cursor: cursor || undefined,
          },
        },
        signal,
      }),
    )
    all.push(...res.items)
    if (!res.next_cursor) {
      break
    }
    cursor = res.next_cursor
  }
  return all
}

/**
 * Hook to fetch and cache all tags under queryKeys.tags.all().
 */
export function useAllTags() {
  return useQuery({
    queryKey: queryKeys.tags.all(),
    queryFn: ({ signal }) => fetchAllTags(signal),
  })
}
