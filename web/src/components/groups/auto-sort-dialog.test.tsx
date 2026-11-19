import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { ApiError } from '@/api/errors'
import { AutoSortDialog } from './auto-sort-dialog'

function renderDialog(open = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AutoSortDialog open={open} onOpenChange={() => {}} />
    </QueryClientProvider>,
  )
}

describe('AutoSortDialog', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('loads dry run, displays numbers and lists, and confirm is disabled until ticked', async () => {
    vi.spyOn(api, 'POST').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/devices/auto-sort/preview') {
        return Promise.resolve({
          data: {
            moves: [
              {
                device: {
                  id: 'd-1',
                  hostname: 'host-1',
                  rustdesk_id: '111',
                  alias: '',
                  state: 'approved',
                  group_id: null,
                },
                from_group: null,
                to_group: { id: 'g-1', name: 'Engineering' },
              },
            ],
            conflicts: [
              {
                device: {
                  id: 'd-2',
                  hostname: 'host-2',
                  rustdesk_id: '222',
                  alias: '',
                  state: 'approved',
                  group_id: null,
                },
                groups: [
                  { id: 'g-1', name: 'Engineering' },
                  { id: 'g-2', name: 'Support' },
                ],
              },
            ],
            unchanged: 5,
          },
        } as never)
      }
      return Promise.reject(new Error(`Unhandled POST ${path}`))
    })

    renderDialog()

    // Title and warning text
    expect(screen.getByText('Auto Sort All')).toBeInTheDocument()
    expect(
      screen.getByText(
        (content) =>
          content.includes('Auto sort moves approved devices into the group their name matches') &&
          content.includes('This cannot be undone; every move is in the audit log.'),
      ),
    ).toBeInTheDocument()

    // Wait for dry run data
    await waitFor(() => {
      expect(screen.getByText('1 device will move, 1 conflict, 5 unchanged')).toBeInTheDocument()
    })

    // Move list and conflict list
    expect(screen.getByText('host-1')).toBeInTheDocument()
    expect(screen.getByText('host-2')).toBeInTheDocument()

    // Confirm button is disabled initially
    const confirmBtn = screen.getByRole('button', { name: 'Auto sort all' })
    expect(confirmBtn).toBeDisabled()

    // Check the confirmation checkbox
    const checkbox = screen.getByRole('checkbox', {
      name: /I understand these devices will move and may get a different client policy/i,
    })
    fireEvent.click(checkbox)

    // Confirm button is now enabled
    expect(confirmBtn).toBeEnabled()
  })

  it('shows no confirm button, just Close, when zero devices will move', async () => {
    vi.spyOn(api, 'POST').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/devices/auto-sort/preview') {
        return Promise.resolve({
          data: {
            moves: [],
            conflicts: [],
            unchanged: 10,
          },
        } as never)
      }
      return Promise.reject(new Error(`Unhandled POST ${path}`))
    })

    renderDialog()

    await waitFor(() => {
      expect(screen.getByText('0 devices will move, 0 conflicts, 10 unchanged')).toBeInTheDocument()
    })

    // No confirm button, only Close
    expect(screen.queryByRole('button', { name: 'Auto sort all' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThanOrEqual(1)
  })

  it('surfaces 503 busy error message when auto sort run encounters lock timeout', async () => {
    vi.spyOn(api, 'POST').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/devices/auto-sort/preview') {
        return Promise.resolve({
          data: {
            moves: [
              {
                device: {
                  id: 'd-1',
                  hostname: 'host-1',
                  rustdesk_id: '111',
                  alias: '',
                  state: 'approved',
                  group_id: null,
                },
                from_group: null,
                to_group: { id: 'g-1', name: 'Engineering' },
              },
            ],
            conflicts: [],
            unchanged: 3,
          },
        } as never)
      }
      if (path === '/admin/api/v1/devices/auto-sort') {
        return Promise.reject(new ApiError(503, 'busy', 'devices are busy, try again'))
      }
      return Promise.reject(new Error(`Unhandled POST ${path}`))
    })

    renderDialog()

    await waitFor(() => {
      expect(screen.getByText('1 device will move, 0 conflicts, 3 unchanged')).toBeInTheDocument()
    })

    // Tick checkbox
    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)

    // Click confirm
    const confirmBtn = screen.getByRole('button', { name: 'Auto sort all' })
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(screen.getByText('devices are busy, try again')).toBeInTheDocument()
    })
  })
})
