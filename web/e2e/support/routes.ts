// Every UI route with the heading of its placeholder page, for the smoke, CSP
// and screenshot runs. `query` is added to the URL (mock switches); `id` marks
// the device detail route, which needs a real device id from the mock.
export interface UIRoute {
  path: string
  heading: string
  query?: string
  id?: true
}

export const ROUTES: UIRoute[] = [
  { path: '/first-run', heading: 'First-run setup', query: 'mock-setup=incomplete' },
  // A fully signed-in user is sent on from /sign-in, and a signed-out one would
  // log the 401 of GET /auth/me: a session that has not passed TOTP sees the form.
  { path: '/sign-in', heading: 'Sign in', query: 'mock-session=mfa' },
  { path: '/sign-in/totp', heading: 'Two-factor code', query: 'mock-session=mfa' },
  {
    path: '/enroll-totp',
    heading: 'Set up two-factor authentication',
    query: 'mock-session=enroll',
  },
  { path: '/', heading: 'Command Center' },
  { path: '/devices', heading: 'Devices' },
  { path: '/devices/$id', heading: 'Device', id: true },
  { path: '/devices/queue', heading: 'Approval Queue' },
  { path: '/sessions', heading: 'Sessions' },
  { path: '/audit', heading: 'Audit Log' },
  { path: '/groups', heading: 'Groups' },
  { path: '/tags', heading: 'Tags' },
  { path: '/policies', heading: 'Client Policies' },
  { path: '/settings', heading: 'Settings' },
  { path: '/settings/server', heading: 'Server' },
  { path: '/settings/thresholds', heading: 'Fleet Thresholds' },
  { path: '/settings/users', heading: 'Users' },
  { path: '/settings/sign-in', heading: 'Sign-In' },
  { path: '/account', heading: 'Account' },
  { path: '/account/appearance', heading: 'Appearance' },
  { path: '/account/dashboard', heading: 'Dashboard Layout' },
  { path: '/dev/kitchen-sink', heading: 'Kitchen sink' },
]

/** The file-name slug of a route: "/" is "command-center", "/devices/$id" is "devices-id". */
export function slug(path: string): string {
  if (path === '/') return 'command-center'
  return path.slice(1).replace(/\$/g, '').replace(/\//g, '-')
}
