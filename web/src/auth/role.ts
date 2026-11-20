import { useMe, type Me } from './session'

/** The signed-in account's role (GET /auth/me). */
export type Role = Me['user']['role']

/**
 * The signed-in role, or undefined while /auth/me is unknown (under the app
 * shell's guard it is always loaded). A User sees a console without the
 * controls the server would refuse (openapi.yaml, "Authorization, by role").
 */
export function useRole(): Role | undefined {
  return useMe().data?.user.role
}

// The pages the server's allow-list gives a User nothing behind: their routes
// redirect to / before anything renders. /account (own settings) stays.
const USER_BLOCKED = ['/settings', '/groups', '/tags', '/devices/queue', '/policies']

const inside = (pathname: string, root: string) =>
  pathname === root || pathname.startsWith(`${root}/`)

/** Whether `role` may open `pathname`. */
export function canVisit(role: Role | undefined, pathname: string): boolean {
  if (role !== 'user') return true
  return !USER_BLOCKED.some((root) => inside(pathname, root))
}

/** Where to send `role` instead of `pathname` (beforeLoad), or undefined to let it through. */
export function redirectForRole(role: Role | undefined, pathname: string): '/' | undefined {
  return canVisit(role, pathname) ? undefined : '/'
}

const MAIN_NAV = ['/', '/devices', '/sessions', '/audit', '/groups', '/tags', '/policies']

/** The paths of the sidebar's main items, in order, that `role` gets. */
export function mainNavPaths(role: Role | undefined): string[] {
  return MAIN_NAV.filter((to) => canVisit(role, to))
}
