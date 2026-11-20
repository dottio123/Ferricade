import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import { meQuery as sessionQuery } from '@/auth/session'
import { queryKeys } from '@/lib/queryKeys'

export type User = components['schemas']['User']

export interface ResolveActorOptions {
  actorUserId: string | null
  action?: string
  actorIp?: string
  currentUserId?: string
  currentUserRole?: string
  usersMap?: Map<string, string>
}

/**
 * Pure function to format an actor's display name safely according to permissions:
 * - If actorUserId is null: "A device or the setup wizard"
 * - If actorUserId matches current user: "You"
 * - If current user is owner: resolves username/display_name from usersMap
 * - If current user is admin: renders "An admin" without querying users (prevents 403 Forbidden)
 */
export function formatActorName({
  actorUserId,
  action,
  actorIp,
  currentUserId,
  currentUserRole,
  usersMap,
}: ResolveActorOptions): string {
  if (actorUserId === null) {
    if (action?.startsWith('auth.')) return `Unknown client at ${actorIp || 'unknown address'}`
    return 'A device or the setup wizard'
  }
  if (currentUserId && actorUserId === currentUserId) {
    return 'You'
  }
  if (currentUserRole === 'owner' && usersMap) {
    const name = usersMap.get(actorUserId)
    if (name) return name
  }
  return 'An admin'
}

/**
 * Loads all users for owners (paginated, follows next_cursor).
 * Disabled for non-owners to avoid 403 Forbidden on GET /users.
 */
export function useAllUsers(isOwner: boolean) {
  return useQuery({
    // Every user, all pages: the root key, so a users change refreshes it.
    queryKey: queryKeys.users.all(),
    queryFn: async ({ signal }): Promise<User[]> => {
      const users: User[] = []
      let cursor: string | undefined = undefined
      while (true) {
        const res: { items: User[]; next_cursor: string } = await unwrap(
          api.GET('/admin/api/v1/users', {
            params: {
              query: {
                limit: 200,
                ...(cursor ? { cursor } : {}),
              },
            },
            signal,
          }),
        )
        users.push(...res.items)
        if (!res.next_cursor) break
        cursor = res.next_cursor
      }
      return users
    },
    enabled: isOwner,
    staleTime: 60_000,
  })
}

/**
 * Reusable hook for audit log and detail views to resolve actor names safely.
 */
export function useAuditActorResolver() {
  const meQuery = useQuery({
    ...sessionQuery,
    staleTime: 60_000,
  })

  const me = meQuery.data
  const isOwner = me?.user.role === 'owner'
  const currentUserId = me?.user.id
  const currentUserRole = me?.user.role

  const usersQuery = useAllUsers(isOwner)

  const usersMap = React.useMemo(() => {
    const map = new Map<string, string>()
    if (usersQuery.data) {
      for (const u of usersQuery.data) {
        map.set(u.id, u.display_name || u.username)
      }
    }
    return map
  }, [usersQuery.data])

  const resolveActor = React.useCallback(
    (actorUserId: string | null, action?: string, actorIp?: string): string => {
      return formatActorName({
        actorUserId,
        action,
        actorIp,
        currentUserId,
        currentUserRole,
        usersMap,
      })
    },
    [currentUserId, currentUserRole, usersMap],
  )

  return {
    resolveActor,
    isOwner,
    users: usersQuery.data ?? [],
    currentUserId,
  }
}
