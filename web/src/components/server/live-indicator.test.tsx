import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionLabel, LiveIndicator } from './live-indicator'

const state = vi.hoisted(() => ({
  live: 'live' as 'live' | 'reconnecting' | 'offline',
  role: 'owner' as 'owner' | 'admin' | 'user' | undefined,
  health: {
    status: 'degraded' as 'ok' | 'degraded' | 'unknown',
    checked_at: '2026-10-14T12:00:00Z' as string | null,
    checks: [
      { name: 'id-server', ok: true, detail: '', since: '2026-10-14T11:00:00Z' },
      {
        name: 'relay',
        ok: false,
        detail: 'relay refused connection',
        since: '2026-10-14T11:30:00Z',
      },
      { name: 'hbbs-online-query', ok: true, detail: '', since: '2026-10-14T11:00:00Z' },
    ],
  },
  fail: false,
  get: vi.fn(),
  post: vi.fn(),
}))

vi.mock('../../live/useLiveEvents', () => ({
  useLiveStatus: () => state.live,
  useLiveStatusSince: () => Date.parse('2026-10-14T11:30:00Z'),
}))
vi.mock('../../auth/role', () => ({ useRole: () => state.role }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, ...props }: { to: string } & React.ComponentProps<'a'>) => (
    <a href={to} {...props} />
  ),
}))
vi.mock('../../api/client', () => ({
  api: { GET: state.get, POST: state.post },
  unwrap: async (result: Promise<unknown>) => result,
}))

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <LiveIndicator />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.live = 'live'
  state.role = 'owner'
  state.fail = false
  state.health.status = 'degraded'
  state.health.checked_at = '2026-10-14T12:00:00Z'
  state.health.checks = [
    { name: 'id-server', ok: true, detail: '', since: '2026-10-14T11:00:00Z' },
    { name: 'relay', ok: false, detail: 'relay refused connection', since: '2026-10-14T11:30:00Z' },
    { name: 'hbbs-online-query', ok: true, detail: '', since: '2026-10-14T11:00:00Z' },
  ]
  state.get.mockImplementation(async () => {
    if (state.fail) throw new Error('health unavailable')
    return state.health
  })
  state.post.mockResolvedValue({ checks: [] })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('LiveIndicator', () => {
  it.each([
    ['offline', 'degraded', 'Server offline'],
    ['reconnecting', 'degraded', 'Reconnecting…'],
    ['live', 'degraded', 'RustDesk server issue'],
    ['live', 'ok', 'Live'],
  ] as const)('connectionLabel(%s, %s) is %s', (status, health, label) => {
    expect(connectionLabel(status, health)).toBe(label)
  })

  it.each([
    ['offline', 'degraded', 'Server offline', 'bg-status-offline'],
    ['reconnecting', 'degraded', 'Reconnecting…', 'bg-status-pending'],
    ['live', 'degraded', 'RustDesk server issue', 'bg-status-pending'],
    ['live', 'ok', 'Live', 'bg-status-online'],
  ] as const)('%s with %s health shows %s', async (live, health, label, dot) => {
    state.live = live
    state.health.status = health
    mount()
    expect(
      await screen.findByRole('button', { name: `Connection status: ${label}` }),
    ).toBeInTheDocument()
    expect(screen.getByRole('status').querySelector('[aria-hidden="true"]')).toHaveClass(dot)
  })

  it('shows both sections and owner controls with failure detail', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Connection status:/ }))
    expect(await screen.findByText('Live updates connected')).toBeInTheDocument()
    expect(screen.getByText('Relay (hbbr)')).toBeInTheDocument()
    expect(screen.getByText('Failing')).toBeInTheDocument()
    expect(screen.queryByText('relay refused connection')).not.toBeInTheDocument()
    const details = screen.getByRole('button', { name: 'Details' })
    expect(details).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(details)
    expect(details).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('relay refused connection')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Server settings' })).toHaveAttribute(
      'href',
      '/settings/server',
    )
    expect(screen.getByText(/Last checked/)).toBeInTheDocument()
  })

  it('hides detail and staff controls for a User', async () => {
    state.role = 'user'
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Connection status:/ }))
    expect(await screen.findByText('Relay (hbbr)')).toBeInTheDocument()
    expect(screen.queryByText('relay refused connection')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument()
    expect(screen.getByText('If this persists, tell an administrator.')).toBeInTheDocument()
  })

  it('shows neither staff controls nor User guidance while the role is unresolved', async () => {
    state.role = undefined
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Connection status:/ }))
    expect(await screen.findByText('Relay (hbbr)')).toBeInTheDocument()
    expect(screen.queryByText('relay refused connection')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Server settings' })).not.toBeInTheDocument()
    expect(screen.queryByText('If this persists, tell an administrator.')).not.toBeInTheDocument()
  })

  it('explains unknown health', async () => {
    state.health.status = 'unknown'
    state.health.checked_at = null
    state.health.checks = []
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Connection status:/ }))
    expect(
      await screen.findByText('Not checked yet (runs every minute once setup is complete)'),
    ).toBeInTheDocument()
  })

  it('keeps the dot live when the health request fails and explains the error', async () => {
    state.fail = true
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Connection status: Live' }))
    expect(await screen.findByText('RustDesk health unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connection status: Live' })).toBeInTheDocument()
  })

  it('checks again and shows an inline error when the check fails', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Connection status:/ }))
    await screen.findByText('Relay (hbbr)')
    state.post.mockRejectedValueOnce(new Error('check failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(state.post).toHaveBeenCalledWith('/admin/api/v1/server/check'))
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument()
  })
})
