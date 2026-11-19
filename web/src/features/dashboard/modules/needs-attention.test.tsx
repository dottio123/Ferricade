import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as groupConflictDialog from '@/components/devices/group-conflict-dialog'
import { NeedsAttentionModule } from './needs-attention'
import { api } from '@/api/client'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string
    search?: unknown
    children: React.ReactNode
  }) => (
    <a href={typeof to === 'string' ? to : '.'} data-search={JSON.stringify(search)} {...props}>
      {children}
    </a>
  ),
}))

import { TooltipProvider } from '@/components/ui/tooltip'

function renderModule(
  attentionItems: Array<{
    kind:
      | 'uuid_mismatch'
      | 'access_window_unconfirmed'
      | 'group_conflict'
      | 'pending_long'
      | 'offline_long'
      | 'outdated_client'
    device_id: string
    rustdesk_id: string
    name: string
    since: string
    detail: string
  }>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  vi.spyOn(api, 'GET').mockImplementation((path: string) => {
    if (path === '/admin/api/v1/stats/summary') {
      return Promise.resolve({
        response: new Response(),
        data: {
          devices: { total: 10, pending: 0, approved: 10, rejected: 0, archived: 0, online: 8 },
          sessions: { active: 1 },
          alerts: { open: attentionItems.length },
          attention: attentionItems,
        },
      } as never)
    }
    return Promise.reject(new Error(`Unhandled GET ${path}`))
  })

  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <NeedsAttentionModule />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

describe('NeedsAttentionModule', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders access_window_unconfirmed with label, device link, and server detail', async () => {
    renderModule([
      {
        kind: 'access_window_unconfirmed',
        device_id: 'dev-access-1',
        rustdesk_id: '987 654 321',
        name: 'Workstation-42',
        since: '2026-10-19T12:00:00Z',
        detail: 'Window closed 10m ago but client did not acknowledge confirmation',
      },
    ])

    await waitFor(() => {
      expect(screen.getByText('Access window not confirmed closed')).toBeInTheDocument()
    })

    expect(
      screen.getByText('Window closed 10m ago but client did not acknowledge confirmation'),
    ).toBeInTheDocument()
    expect(screen.getByText('Workstation-42')).toBeInTheDocument()
    expect(screen.getByText('987 654 321')).toBeInTheDocument()

    const deviceLink = screen.getByText('Workstation-42').closest('a')
    expect(deviceLink).toBeInTheDocument()
  })

  it('renders group_conflict row and clicking it opens resolution window', async () => {
    const openConflictSpy = vi.spyOn(groupConflictDialog, 'openGroupConflictDialog')

    renderModule([
      {
        kind: 'group_conflict',
        device_id: 'dev-conflict-1',
        rustdesk_id: '123 456 789',
        name: 'Laptop-7',
        since: '2026-10-22T12:00:00Z',
        detail: 'Matches Engineering and Support',
      },
    ])

    await waitFor(() => {
      expect(screen.getByText('Group conflict')).toBeInTheDocument()
    })

    expect(screen.getByText('Laptop-7')).toBeInTheDocument()
    expect(screen.getByText('Matches Engineering and Support')).toBeInTheDocument()

    const conflictRow = screen.getByText('Laptop-7').closest('[role="button"]')
    expect(conflictRow).toBeInTheDocument()
    fireEvent.click(conflictRow!)

    expect(openConflictSpy).toHaveBeenCalledWith({
      deviceId: 'dev-conflict-1',
    })
  })
})
