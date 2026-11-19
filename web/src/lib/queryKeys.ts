// Every TanStack Query key the app uses. Pages build their keys here, never
// inline, so the live updates (src/live/invalidation.ts) reach them: an event
// invalidates a key and every key that starts with it (['devices'] covers
// ['devices', {state: 'pending'}]).
//
// The first element (the root) says what the data is; the rest narrows it
// (list filters, an id, a range). A new kind of data gets a new root here.
// Every entry is a function, and its arguments are typed from the contract's
// query parameters. `all()`, and an entry whose id or range is left out, give
// the key that covers every one of that kind (for invalidation).
//
// A list read page by page (useInfiniteQuery) takes its key from `infinite()`,
// never `list()`: the two cache different shapes (one page, or every page read
// so far), so they must never share a key. `infinite()` keeps the root, so live
// invalidation reaches it, and leaves out the cursor (the page param).
import type { paths } from '../api/schema'

type Query<P extends keyof paths> = paths[P] extends {
  get: { parameters: { query?: infer Q } }
}
  ? NonNullable<Q>
  : never

export type DeviceListParams = Query<'/admin/api/v1/devices'>
export type SessionListParams = Query<'/admin/api/v1/sessions'>
export type AuditListParams = Query<'/admin/api/v1/audit'>
export type TagListParams = Query<'/admin/api/v1/tags'>
export type UserListParams = Query<'/admin/api/v1/users'>
export type HistoryRange = Query<'/admin/api/v1/stats/history'>['range']
export type SessionStatsParams = Query<'/admin/api/v1/sessions/stats'>
/** A list's filters without the cursor, which useInfiniteQuery passes as its page param. */
export type InfiniteParams<P> = Omit<P, 'cursor'>

export const queryKeys = {
  /** GET /setup/status. */
  setupStatus: () => ['setup-status'] as const,
  /** GET /auth/oidc: public provider state, independent of the session. */
  oidcPublic: () => ['auth', 'oidc', 'public'] as const,
  /** GET /auth/me: the signed-in user and session state. */
  me: () => ['me'] as const,

  devices: {
    /** Every device list. */
    all: () => ['devices'] as const,
    /** GET /devices with these filters (one page). */
    list: (params: DeviceListParams = {}) => ['devices', params] as const,
    /** GET /devices with these filters, page by page (useInfiniteQuery). */
    infinite: (params: InfiniteParams<DeviceListParams> = {}) =>
      ['devices', 'infinite', params] as const,
  },
  /** GET /devices/{id} (and what the detail page shows of that device); every device without an id. */
  device: (id?: string) => (id === undefined ? (['device'] as const) : (['device', id] as const)),
  /** GET /devices/{id}/policy: effective policy and access window status. */
  devicePolicy: (id: string) => [...queryKeys.device(id), 'policy'] as const,
  deviceIDAllowList: (id: string) => [...queryKeys.device(id), 'id-allow-list'] as const,
  /** GET /settings/policy-push: policy push fleet switch state. */
  policyPush: () => ['settings', 'policy-push'] as const,
  /** GET /settings/log-export: log export settings and status. */
  logExport: () => ['settings', 'log-export'] as const,
  settingsIDAllowList: () => ['settings', 'id-allow-list'] as const,

  /** GET /stats/summary. */
  summary: () => ['summary'] as const,
  /** GET /stats/fleet-map. */
  fleetMap: () => ['fleet-map'] as const,
  /** GET /stats/history?range=. */
  history: (range: HistoryRange) => ['history', range] as const,

  sessions: {
    /** Every session list. */
    all: () => ['sessions'] as const,
    /** GET /sessions with these filters (one page). */
    list: (params: SessionListParams = {}) => ['sessions', params] as const,
    /** GET /sessions with these filters, page by page (useInfiniteQuery). */
    infinite: (params: InfiniteParams<SessionListParams> = {}) =>
      ['sessions', 'infinite', params] as const,
  },
  /** GET /sessions/stats?range=&tz= (tz changes the day buckets, so it is part of the key). */
  sessionStats: (params?: SessionStatsParams) =>
    params === undefined ? (['session-stats'] as const) : (['session-stats', params] as const),

  audit: {
    /** Every audit list. */
    all: () => ['audit'] as const,
    /** GET /audit with these filters (one page). */
    list: (params: AuditListParams = {}) => ['audit', params] as const,
    /** GET /audit with these filters, page by page (useInfiniteQuery). */
    infinite: (params: InfiniteParams<AuditListParams> = {}) =>
      ['audit', 'infinite', params] as const,
  },

  /** GET /me/preferences. */
  preferences: () => ['preferences'] as const,
  /** GET /settings/dashboard (owner thresholds). */
  dashboardSettings: () => ['dashboard-settings'] as const,
  /** GET /dashboard/catalog. */
  dashboardCatalog: () => ['dashboard-catalog'] as const,

  /** GET /groups: the whole tree (the endpoint takes no parameters). */
  groups: () => ['groups'] as const,
  groupIDAllowList: (id: string) => ['groups', id, 'id-allow-list'] as const,
  /** GET /group-rules. */
  groupRules: () => ['group-rules'] as const,
  /** GET /policies: the whole list (the endpoint takes no parameters). */
  policies: () => ['policies'] as const,
  /** GET /policies/{id}; every policy without an id. */
  policy: (id?: string) => (id === undefined ? (['policy'] as const) : (['policy', id] as const)),
  tags: {
    /** Every tag list. */
    all: () => ['tags'] as const,
    /** GET /tags with this page size and cursor. */
    list: (params: TagListParams = {}) => ['tags', params] as const,
  },
  users: {
    /** Every user list. */
    all: () => ['users'] as const,
    /** GET /users with this page size and cursor. */
    list: (params: UserListParams = {}) => ['users', params] as const,
  },
  /** GET /server. */
  server: () => ['server'] as const,
  /** GET /server/health. */
  serverHealth: () => ['server-health'] as const,
  /** GET /server/client-config. */
  clientConfig: () => ['client-config'] as const,
}
