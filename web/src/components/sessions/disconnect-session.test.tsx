import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DisconnectSession } from './disconnect-session'
import type { RemoteSession } from './sessions-table'

const role = vi.hoisted(() => ({ value: 'owner' as string | undefined }))
vi.mock('@/auth/role', () => ({ useRole: () => role.value }))
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const open = {
  id: 'session-1',
  device_id: 'device-1',
  device_name: 'Workstation',
  started_at: '2026-10-11T12:00:00Z',
  ended_at: null,
  authed_at: '2026-10-11T12:00:01Z',
  duration_seconds: 10,
  type: 'remote',
  peer_name: 'Peer',
  peer_rustdesk_id: '123',
  rustdesk_id: '456',
  client_ip: '192.0.2.1',
  end_reason: null,
  disconnect_requested_at: null,
} as RemoteSession

function show(session: RemoteSession, compact = false) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <DisconnectSession session={session} compact={compact} />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

afterEach(cleanup)

beforeEach(() => {
  role.value = 'owner'
})

describe('DisconnectSession', () => {
  it('offers a Disconnect button on an open session', () => {
    show(open)
    expect(screen.getByRole('button', { name: /Disconnect Peer from Workstation/ })).toBeTruthy()
  })

  it('names the peer id when the peer has no name, in the compact layout too', () => {
    show({ ...open, peer_name: '' }, true)
    expect(screen.getByRole('button', { name: 'Disconnect 123 from Workstation' })).toBeTruthy()
  })

  it('shows Disconnecting… once a disconnect was requested', () => {
    show({ ...open, disconnect_requested_at: '2026-10-11T12:00:05Z' })
    expect(screen.getByText('Disconnecting…')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows nothing for an ended session', () => {
    const view = show({ ...open, ended_at: '2026-10-11T12:05:00Z', end_reason: 'closed' })
    expect(view.container.textContent).toBe('')
  })

  it('shows nothing to a User', () => {
    role.value = 'user'
    const view = show(open)
    expect(view.container.textContent).toBe('')
  })

  it('provides a touch target of at least 44px on mobile for the compact button', () => {
    show(open, true)
    const btn = screen.getByRole('button', { name: /Disconnect Peer from Workstation/ })
    expect(btn.className).toContain('min-h-[44px]')
    expect(btn.className).toContain('min-w-[44px]')
  })
})
