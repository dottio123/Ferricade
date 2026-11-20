import { createMemoryHistory } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { setupServer } from 'msw/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { installSessionHandlers } from './auth/unauthorized'
import { queryKeys } from './lib/queryKeys'
import { createQueryClient } from './lib/queryClient'
import { readMockConfig, DEMO } from './mocks/config'
import { createMockDB } from './mocks/db'
import { createMockApi } from './mocks/handlers'
import type { Env } from './mocks/route'
import { createAppRouter } from './router'

vi.setConfig({ testTimeout: 15_000 })

// The shell opens the live stream; these tests do not need it.
class SilentEventSource {
  readyState = 0
  addEventListener() {}
  close() {}
}

let stopServer: () => void = () => {}

beforeEach(() => {
  vi.stubGlobal('EventSource', SilentEventSource)
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  stopServer()
  vi.unstubAllGlobals()
})

function renderAt(path: string, opts: { mock?: string; session?: (env: Env) => void } = {}) {
  const db = createMockDB('small')
  const { handlers, env } = createMockApi(db, readMockConfig(opts.mock ?? ''))
  opts.session?.(env)
  const server = setupServer(...handlers)
  server.listen({ onUnhandledRequest: 'error' })
  stopServer = () => server.close()
  const queryClient = createQueryClient()
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  installSessionHandlers(router, queryClient)
  render(<App router={router} queryClient={queryClient} />)
  return { router, env, queryClient, server }
}

// Under three full-suite jobs, Devices took 3,506 ms and Command Center 1,450 ms to appear.
const heading = (name: string) =>
  screen.findByRole('heading', { level: 1, name }, { timeout: 5_000 })
const signedOut = (env: Env) => {
  env.session.userId = null
}

describe('signed in', () => {
  it('sorts devices from table headers and includes sort in the request', async () => {
    const { router, server } = renderAt('/devices')
    await heading('Devices')
    const deviceQueries: URLSearchParams[] = []
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url)
      if (url.pathname === '/admin/api/v1/devices') deviceQueries.push(url.searchParams)
    })

    const deviceSort = await screen.findByRole('button', { name: 'Sort by Device' })
    fireEvent.click(deviceSort)
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ sort: 'name', order: 'asc' }),
    )
    await vi.waitFor(() =>
      expect(screen.getByRole('columnheader', { name: /Device/ })).toHaveAttribute(
        'aria-sort',
        'ascending',
      ),
    )
    fireEvent.click(deviceSort)
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ sort: 'name', order: 'desc' }),
    )
    await vi.waitFor(() =>
      expect(screen.getByRole('columnheader', { name: /Device/ })).toHaveAttribute(
        'aria-sort',
        'descending',
      ),
    )
    fireEvent.click(deviceSort)
    await vi.waitFor(() => expect(router.state.location.search).not.toHaveProperty('sort'))
    fireEvent.click(await screen.findByRole('button', { name: 'Sort by State' }))
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ sort: 'state', order: 'asc' }),
    )
    await vi.waitFor(() =>
      expect(
        deviceQueries.some(
          (query) => query.get('sort') === 'state' && query.get('order') === 'asc',
        ),
      ).toBe(true),
    )
    // A search that matches a device: with no match, the empty state adds a second "Clear filters"
    // once the response lands, and getByRole races it (t239).
    fireEvent.change(screen.getByPlaceholderText('Search ID, alias, host, user…'), {
      target: { value: 'nas-01' },
    })
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        q: 'nas-01',
        sort: 'state',
        order: 'asc',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ sort: 'state', order: 'asc' }),
    )
    expect(router.state.location.search).not.toHaveProperty('q')
  })

  it('ignores unknown device sort values and lets the phone sort control set sort params', async () => {
    const { router, server, queryClient } = renderAt('/devices?sort=bogus&order=up')
    await heading('Devices')
    expect(screen.getByRole('columnheader', { name: /Device/ })).toHaveAttribute(
      'aria-sort',
      'none',
    )
    const deviceQueries: URLSearchParams[] = []
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url)
      if (url.pathname === '/admin/api/v1/devices') deviceQueries.push(url.searchParams)
    })
    await queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
    await vi.waitFor(() => expect(deviceQueries.some((query) => !query.has('sort'))).toBe(true))
    const scrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = vi.fn()
    fireEvent.click(await screen.findByRole('combobox', { name: 'Sort devices' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Sort: Device' }))
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    expect(await screen.findByRole('combobox', { name: 'Sort devices' })).toHaveTextContent(
      'Sort: Device',
    )
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ sort: 'name', order: 'asc' }),
    )
  })

  it('shows the page', async () => {
    renderAt('/devices')
    expect(await heading('Devices')).toBeInTheDocument()
  })

  it('maps Ungrouped to the API parameter and clears its active chip', async () => {
    const { router, server } = renderAt('/devices')
    await heading('Devices')
    const deviceQueries: URLSearchParams[] = []
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url)
      if (url.pathname === '/admin/api/v1/devices') deviceQueries.push(url.searchParams)
    })
    await screen.getByRole('button', { name: 'Filter by group' }).click()
    fireEvent.click(await screen.findByRole('treeitem', { name: 'Ungrouped' }))
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ group: 'ungrouped' }),
    )
    await vi.waitFor(() => {
      expect(
        deviceQueries.some((query) => query.get('ungrouped') === 'true' && !query.has('group')),
      ).toBe(true)
    })
    expect(screen.getByText('Ungrouped', { selector: '[data-slot="badge"]' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ungrouped filter' }))
    await vi.waitFor(() => expect(router.state.location.search).not.toHaveProperty('group'))
  })

  it('includes selected group descendants from the device filter and URL', async () => {
    const { router, server } = renderAt('/devices', {
      session: (env) => {
        const parent = env.db.groups[0]!
        const child = {
          ...parent,
          id: '00000000-0000-4000-8000-000000000098',
          name: 'Subgroup',
          parent_id: parent.id,
        }
        env.db.groups.push(child)
        const base = env.db.deviceRows[0]!
        env.db.deviceRows = [
          {
            ...base,
            id: '00000000-0000-4000-8000-000000000091',
            rustdesk_id: 'parent-device',
            alias: 'Parent device',
            group_id: parent.id,
            state: 'approved',
          },
          {
            ...base,
            id: '00000000-0000-4000-8000-000000000092',
            rustdesk_id: 'child-device',
            alias: 'Child device',
            group_id: child.id,
            state: 'approved',
          },
        ]
      },
    })
    await heading('Devices')
    const deviceQueries: URLSearchParams[] = []
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url)
      if (url.pathname === '/admin/api/v1/devices') deviceQueries.push(url.searchParams)
    })
    expect(screen.queryByLabelText('Include subgroups')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Filter by group' }))
    fireEvent.click(await screen.findByRole('treeitem', { name: 'Home' }))
    expect(await screen.findByLabelText('Include subgroups')).not.toBeChecked()
    expect(await screen.findByText('Parent device')).toBeInTheDocument()
    expect(screen.queryByText('Child device')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Include subgroups'))
    await vi.waitFor(() => expect(router.state.location.search).toMatchObject({ subgroups: true }))
    await vi.waitFor(() =>
      expect(
        deviceQueries.some((query) => query.get('group') && query.get('subgroups') === 'true'),
      ).toBe(true),
    )
    expect(await screen.findByText('Child device')).toBeInTheDocument()
    expect(
      screen.getByText('Home and subgroups', { selector: '[data-slot="badge"]' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Home filter' }))
    await vi.waitFor(() => expect(router.state.location.search).not.toHaveProperty('subgroups'))
  })

  it('shows the command center at /', async () => {
    renderAt('/')
    expect(await heading('Command Center')).toBeInTheDocument()
  })

  it('sends /first-run to the command center once setup is done', async () => {
    const { router } = renderAt('/first-run')
    expect(await heading('Command Center')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/')
  })

  it('limits the first-run owner password input to 256 characters', async () => {
    renderAt('/first-run', { mock: '?mock-setup=incomplete' })
    fireEvent.change(await screen.findByLabelText('Setup token'), {
      target: { value: DEMO.setupToken },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByLabelText('Password')).toHaveAttribute('maxLength', '256')
  })

  it('leaves the sign-in steps for next when MFA has already passed', async () => {
    const { router } = renderAt('/sign-in/totp?next=%2Fsessions')
    expect(await heading('Sessions')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/sessions')
  })

  it('sends a signed-in user from /sign-in on to next', async () => {
    const { router } = renderAt('/sign-in?next=%2Faudit%3Faction%3Ddevice.approve')
    expect(await heading('Audit Log')).toBeInTheDocument()
    expect(router.state.location.href).toBe('/audit?action=device.approve')
  })

  it('sends a signed-in user from /sign-in to the command center when next is not safe', async () => {
    const { router } = renderAt('/sign-in?next=%2Fa%2F..%2F%2Fevil.example')
    expect(await heading('Command Center')).toBeInTheDocument()
    expect(router.state.location.href).toBe('/')
  })

  it('shows "Page not found" for an unknown path', async () => {
    renderAt('/nope')
    expect(await heading('Page not found')).toBeInTheDocument()
  })

  it('serves the kitchen sink in development and tests', async () => {
    renderAt('/dev/kitchen-sink')
    const h = await heading('Kitchen sink')
    // The marker scripts/check-dist.mjs looks for: it must never reach dist/.
    expect(h.closest('[data-dev-only="kitchen-sink"]')).not.toBeNull()
  })
})

describe('the auth guard', () => {
  it('sends a missing session to sign-in, keeping the page as next', async () => {
    const { router } = renderAt('/devices?state=pending', { session: signedOut })
    expect(await heading('Sign in')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/sign-in')
    expect(router.state.location.search).toEqual({ next: '/devices?state=pending' })
  })

  it('leaves next out for the command center', async () => {
    const { router } = renderAt('/', { session: signedOut })
    expect(await heading('Sign in')).toBeInTheDocument()
    expect(router.state.location.search).toEqual({})
  })

  it('sends a session that has not passed TOTP to the TOTP step', async () => {
    const { router } = renderAt('/audit', {
      session: (env) => {
        env.session.mfaPassed = false
      },
    })
    expect(await heading('Two-factor code')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/sign-in/totp')
    expect(router.state.location.search).toEqual({ next: '/audit' })
  })

  it('sends a user who must enroll TOTP to the enrollment page', async () => {
    const { router } = renderAt('/audit', {
      session: (env) => {
        env.session.mfaPassed = false
        env.session.totpEnrolled = false
      },
    })
    expect(await heading('Set up two-factor authentication')).toBeInTheDocument()
    expect(router.state.location.search).toEqual({ next: '/audit' })
  })

  it('sends the TOTP step without a session back to sign-in', async () => {
    const { router } = renderAt('/sign-in/totp?next=%2Faudit', { session: signedOut })
    expect(await heading('Sign in')).toBeInTheDocument()
    expect(router.state.location.search).toEqual({ next: '/audit' })
  })

  it('signs in, passes TOTP and returns to next', async () => {
    const { router } = renderAt('/sign-in?next=%2Fdevices', { session: signedOut })
    await heading('Sign in')
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alex' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: DEMO.password } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await heading('Two-factor code')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: DEMO.totpCode } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await heading('Devices')).toBeInTheDocument()
    expect(router.state.location.href).toBe('/devices')
  })

  it('never follows an absolute next after sign-in', async () => {
    const { router } = renderAt('/sign-in?next=https%3A%2F%2Fevil.example%2F', {
      session: signedOut,
    })
    await heading('Sign in')
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alex' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: DEMO.password } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await heading('Two-factor code')
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: DEMO.totpCode } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await heading('Command Center')).toBeInTheDocument()
    expect(router.state.location.href).toBe('/')
  })

  it('shows a wrong password', async () => {
    renderAt('/sign-in', { session: signedOut })
    await heading('Sign in')
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alex' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That username and password don't match.",
    )
  })

  it('keeps a session that has not passed TOTP on /sign-in (another user may sign in)', async () => {
    const { router } = renderAt('/sign-in', { mock: '?mock-session=mfa' })
    expect(await heading('Sign in')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/sign-in')
  })

  it("forgets the previous session's data when someone signs in", async () => {
    const { queryClient } = renderAt('/sign-in', { session: signedOut })
    await heading('Sign in')
    const previous = queryKeys.devices.list({ state: 'pending' })
    queryClient.setQueryData(previous, ["the previous user's devices"])
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alex' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: DEMO.password } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await heading('Two-factor code')
    expect(queryClient.getQueryData(previous)).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.setupStatus())).toEqual({
      setup_complete: true,
      plain_http: false,
    })
  })

  it('sends a 401 mid-session to sign-in with the current page as next', async () => {
    const { router, env, queryClient } = renderAt('/devices')
    await heading('Devices')
    env.session.userId = null
    await queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
    expect(await heading('Sign in')).toBeInTheDocument()
    expect(router.state.location.search).toEqual({ next: '/devices' })
  })

  it('tells an admin that only owners can manage users', async () => {
    renderAt('/settings/users', { mock: '?mock-role=admin' })
    expect(await screen.findByText('Only owners can manage users.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Users' })).not.toBeInTheDocument()
  })

  it('shows users to the owner', async () => {
    renderAt('/settings/users')
    expect(await heading('Users')).toBeInTheDocument()
  })
})

describe('the shell navigation', () => {
  const nav = () => screen.getByRole('navigation', { name: 'Main' })

  it('marks only the current page as current (the Command Center link only on /)', async () => {
    renderAt('/devices')
    await heading('Devices')
    const current = nav().querySelectorAll('a[aria-current="page"]')
    expect([...current].map((a) => a.textContent?.trim())).toEqual([
      expect.stringMatching(/^Devices/),
    ])
  })

  it('keeps every link named when the sidebar is unpinned and collapsed', async () => {
    renderAt('/devices')
    await heading('Devices')
    fireEvent.click(screen.getByRole('button', { name: 'Unpin sidebar' }))
    expect(screen.getByRole('button', { name: 'Pin sidebar' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(localStorage.getItem('ferricade.sidebar.pinned')).toBe('false')
    for (const name of [
      'Command Center',
      'Devices',
      'Sessions',
      'Audit Log',
      'Groups',
      'Tags',
      'Policies',
    ]) {
      expect(within(nav()).getByRole('link', { name: new RegExp(`^${name}`) })).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: /^System Settings/ })).toBeInTheDocument()
  })

  it('keeps the unpinned sidebar open until focus leaves, then closes after the delay', async () => {
    localStorage.setItem('ferricade.sidebar.pinned', 'false')
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderAt('/devices')
    await heading('Devices')
    const sidebar = screen.getByRole('navigation', { name: 'Main' }).closest('aside')!
    expect(sidebar).toHaveClass('w-16')
    const link = within(sidebar).getByRole('link', { name: /^Devices/ })
    act(() => link.focus())
    expect(screen.getByRole('button', { name: 'Pin sidebar' })).toBeInTheDocument()
    expect(sidebar).toHaveClass('w-16')
    document.body.tabIndex = -1
    act(() => {
      link.blur()
      document.body.focus()
    })
    await vi.advanceTimersByTimeAsync(299)
    expect(screen.getByRole('button', { name: 'Pin sidebar' })).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(1)
    expect(screen.queryByRole('button', { name: 'Pin sidebar' })).not.toBeInTheDocument()
  })

  it('keeps the focused item focused when Escape collapses the unpinned sidebar', async () => {
    localStorage.setItem('ferricade.sidebar.pinned', 'false')
    renderAt('/devices')
    await heading('Devices')
    const link = screen.getByRole('link', { name: /^Devices/ })
    act(() => link.focus())
    expect(screen.getByRole('button', { name: 'Pin sidebar' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('link', { name: /^Devices/ }), { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Pin sidebar' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Devices/ })).toHaveFocus()
  })

  it('defaults to pinned and remains usable when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    renderAt('/devices')
    await heading('Devices')
    const unpin = screen.getByRole('button', { name: 'Unpin sidebar' })
    expect(unpin).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(unpin)
    expect(screen.getByRole('button', { name: 'Pin sidebar' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('closes unpinned sidebar on pointer leave after clicking unpin or a nav link even with focus inside', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderAt('/devices')
    await heading('Devices')
    const sidebar = screen.getByRole('navigation', { name: 'Main' }).closest('aside')!

    const unpin = screen.getByRole('button', { name: 'Unpin sidebar' })
    fireEvent.pointerEnter(sidebar)
    fireEvent.pointerDown(unpin)
    act(() => unpin.focus())
    fireEvent.click(unpin)

    const pin = screen.getByRole('button', { name: 'Pin sidebar' })
    expect(pin).toBeInTheDocument()
    expect(pin).toHaveFocus()

    fireEvent.pointerLeave(sidebar)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(screen.queryByRole('button', { name: 'Pin sidebar' })).not.toBeInTheDocument()

    // Hover back in, click a nav link: stays open while pointer is over sidebar, closes on leave
    fireEvent.pointerEnter(sidebar)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(screen.getByRole('button', { name: 'Pin sidebar' })).toBeInTheDocument()

    const sessionsLink = within(sidebar).getByRole('link', { name: /^Sessions/ })
    fireEvent.pointerDown(sessionsLink)
    act(() => sessionsLink.focus())
    fireEvent.click(sessionsLink)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(screen.getByRole('button', { name: 'Pin sidebar' })).toBeInTheDocument()

    fireEvent.pointerLeave(sidebar)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(screen.queryByRole('button', { name: 'Pin sidebar' })).not.toBeInTheDocument()
  })
})

describe('a 403 asking for the second factor mid-session', () => {
  it('sends the user to the TOTP step, keeping the page in next', async () => {
    const { router, env, queryClient } = renderAt('/devices')
    await heading('Devices')
    // The server now wants the second factor again (as after a TOTP reset).
    env.session.mfaPassed = false
    await queryClient.refetchQueries({ queryKey: queryKeys.summary() })

    expect(await heading('Two-factor code')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/sign-in/totp')
    expect(router.state.location.search).toEqual({ next: '/devices' })
  })
})

describe('sign-out', () => {
  it('lands on /sign-in without passing through the command center', async () => {
    const { router, server } = renderAt('/')
    await heading('Command Center')
    const visited: string[] = []
    router.subscribe('onBeforeNavigate', (e) => visited.push(e.toLocation.pathname))
    const requests: string[] = []
    server.events.on('request:start', ({ request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
    })

    const profileBtn = screen.getByRole('button', { name: /Profile/i })
    fireEvent.keyDown(profileBtn, { key: 'Enter', code: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }))
    expect(await heading('Sign in')).toBeInTheDocument()
    // Let anything that would follow (a redirect, a refetch, a 401) happen.
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(router.state.location.pathname).toBe('/sign-in')
    expect(visited).toEqual(['/sign-in'])
    expect(requests).not.toContain('GET /admin/api/v1/stats/summary')
    expect(requests).toContain('POST /admin/api/v1/auth/logout')
  })
})

describe('setup detection', () => {
  it('sends every page to /first-run while setup is open', async () => {
    const { router } = renderAt('/devices', { mock: '?mock-setup=incomplete' })
    expect(await heading('First-run setup')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/first-run')
  })

  it('sends sign-in to /first-run too', async () => {
    const { router } = renderAt('/sign-in', { mock: '?mock-setup=incomplete' })
    expect(await heading('First-run setup')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/first-run')
  })
})

describe('plain HTTP indicator', () => {
  const NOTICE =
    'This console is served over plain HTTP. Sign-ins and session cookies are not encrypted on the network.'

  it('is absent on the signed-in console and sign-in page when plain_http is false', async () => {
    renderAt('/')
    await heading('Command Center')
    expect(screen.queryByRole('button', { name: 'Plain HTTP connection' })).not.toBeInTheDocument()
    cleanup()

    renderAt('/sign-in', { session: signedOut })
    await heading('Sign in')
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
  })

  it('shows the console indicator and sign-in helper text when plain_http is true', async () => {
    renderAt('/', { mock: '?mock-http=plain' })
    await heading('Command Center')
    const trigger = await screen.findByRole('button', { name: 'Plain HTTP connection' })
    expect(trigger).toHaveTextContent('HTTP')
    fireEvent.click(trigger)
    expect(await screen.findByText(NOTICE)).toBeInTheDocument()
    cleanup()

    renderAt('/sign-in', { mock: '?mock-http=plain', session: signedOut })
    await heading('Sign in')
    expect(await screen.findByText(NOTICE)).toBeInTheDocument()
  })
})
