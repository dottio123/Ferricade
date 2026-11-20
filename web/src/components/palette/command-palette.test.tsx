import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '@/api/client'
import { queryKeys } from '@/lib/queryKeys'
import { CommandPalette } from './command-palette'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/auth/session', () => ({ useMe: () => ({ data: { user: { role: 'user' } } }) }))
vi.mock('@/features/appearance/use-theme-switch', () => ({
  useThemeSwitch: () => ({ cycleTheme: vi.fn() }),
}))
vi.mock('@/components/devices/use-approve-devices', () => ({
  useApproveDevices: () => ({ approve: vi.fn() }),
}))
vi.mock('@/hooks/use-connect-link', () => ({
  useConnectLink: () => ({ connect: vi.fn(), isLoading: false, error: null, clearError: vi.fn() }),
}))
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

describe('CommandPalette policy Connect', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => cleanup())

  it('shows a locked device action disabled, then enables it on policy refetch', async () => {
    const device = {
      id: 'dev-1',
      rustdesk_id: '123456789',
      alias: 'Office PC',
      hostname: 'office-pc',
      state: 'approved',
      online: true,
      conns: [],
      open_alerts: [],
      tags: [],
    }
    const policy = { connect: 'locked', status: 'pending' }
    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/stats/summary')
        return Promise.resolve({
          response: new Response(),
          data: { devices: { pending: 0 } },
        } as never)
      if (path === '/admin/api/v1/devices')
        return Promise.resolve({
          response: new Response(),
          data: { items: [device], next_cursor: '' },
        } as never)
      if (path === '/admin/api/v1/devices/{id}/policy')
        return Promise.resolve({ response: new Response(), data: { ...policy } } as never)
      return Promise.reject(new Error(`Unhandled GET ${path}`))
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <CommandPalette open onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    )
    fireEvent.change(screen.getByPlaceholderText('Type a command or search devices…'), {
      target: { value: 'Office' },
    })
    const row = await screen.findByRole('option', { name: /Office PC/ })
    expect(row.querySelector('.device-action-note')).toHaveTextContent(
      'Locked by policy. Allow access first.',
    )
    expect(row.querySelector('.device-action-hint')).toHaveClass('pointer-fine:sm:inline')
    expect(row).toHaveAttribute('data-disabled', 'true')
    policy.connect = 'attended'
    await client.invalidateQueries({ queryKey: queryKeys.devicePolicy(device.id) })
    await waitFor(() =>
      expect(
        screen.getByText('Someone at the device must accept.').closest('[cmdk-item]'),
      ).not.toHaveAttribute('data-disabled', 'true'),
    )
    policy.connect = 'window'
    await client.invalidateQueries({ queryKey: queryKeys.devicePolicy(device.id) })
    expect(await screen.findByText('Applying access…')).toBeInTheDocument()
  })
})
