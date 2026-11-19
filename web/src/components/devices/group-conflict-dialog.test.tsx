import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { components } from '@/api/schema'
import { ToasterProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  GlobalGroupConflictDialog,
  GroupConflictDialog,
  openGroupConflictDialog,
} from './group-conflict-dialog'

type Device = components['schemas']['Device']

const mockDevice: Device = {
  id: 'dev-1',
  rustdesk_id: '111 222 333',
  uuid: 'uuid-1',
  state: 'approved',
  alias: 'Workstation 1',
  hostname: 'ws-eng-01',
  os: 'Windows 11',
  cpu: 'x86_64',
  memory: '16GB',
  client_version: '1.4.0',
  online: true,
  conns: [],
  group_id: null,
  tags: [],
  open_alerts: [
    {
      id: 'alert-conflict-1',
      kind: 'group_conflict',
      seen_uuid: null,
      ip: null,
      created_at: '2026-10-22T10:00:00Z',
      window_closed_at: null,
      groups: [
        { id: 'grp-eng', name: 'Engineering' },
        { id: 'grp-support', name: 'Support' },
      ],
    },
  ],
} as unknown as Device

function renderDialog(props: Partial<React.ComponentProps<typeof GroupConflictDialog>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ToasterProvider>
        <TooltipProvider>
          <GroupConflictDialog
            open={true}
            onOpenChange={() => {}}
            deviceId="dev-1"
            initialDevice={mockDevice}
            {...props}
          />
        </TooltipProvider>
      </ToasterProvider>
    </QueryClientProvider>,
  )
}

describe('GroupConflictDialog', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders device details, hostname, matching groups and Keep option', async () => {
    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: {
            items: [
              {
                id: 'grp-eng',
                name: 'Engineering',
                parent_id: null,
                policy_id: null,
                effective_policy_id: '',
                children: [],
              },
              {
                id: 'grp-support',
                name: 'Support',
                parent_id: null,
                policy_id: null,
                effective_policy_id: '',
                children: [],
              },
            ],
          },
        } as never)
      }
      return Promise.reject(new Error(`Unhandled GET ${path}`))
    })

    renderDialog()

    expect(screen.getByText('Resolve Group Conflict')).toBeInTheDocument()
    expect(screen.getByText('Workstation 1')).toBeInTheDocument()
    expect(screen.getByText('ws-eng-01')).toBeInTheDocument()
    expect(screen.getByText('Engineering')).toBeInTheDocument()
    expect(screen.getByText('Support')).toBeInTheDocument()
    expect(screen.getByText('Keep where it is')).toBeInTheDocument()
    expect(screen.getByText('Current placement: No group')).toBeInTheDocument()
  })

  it('choosing a group sends PATCH /devices/{id} with group_id', async () => {
    vi.spyOn(api, 'GET').mockResolvedValue({ data: { items: [] } } as never)
    const patchSpy = vi.spyOn(api, 'PATCH').mockResolvedValue({
      data: { ...mockDevice, group_id: 'grp-support', open_alerts: [] },
    } as never)
    const onOpenChange = vi.fn()

    renderDialog({ onOpenChange })

    // Select 'Support'
    const supportRadio = screen.getByRole('radio', { name: /Support/i })
    fireEvent.click(supportRadio)

    const applyBtn = screen.getByRole('button', { name: 'Apply' })
    fireEvent.click(applyBtn)

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith('/admin/api/v1/devices/{id}', {
        params: { path: { id: 'dev-1' } },
        body: { group_id: 'grp-support' },
      })
    })

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it('labels the current matching group as Keep and PATCHes it when applied', async () => {
    const currentDevice = { ...mockDevice, group_id: 'grp-eng' }
    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/devices/{id}')
        return Promise.resolve({ data: currentDevice } as never)
      return Promise.resolve({ data: { items: [] } } as never)
    })
    const patchSpy = vi
      .spyOn(api, 'PATCH')
      .mockResolvedValue({ data: { ...currentDevice, open_alerts: [] } } as never)
    renderDialog({ initialDevice: currentDevice })

    const keepCurrent = await screen.findByRole('radio', {
      name: /Keep in Engineering \(current group\)/i,
    })
    expect(screen.getByText('Clear the conflict and keep its current group')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(patchSpy).toHaveBeenCalledWith('/admin/api/v1/devices/{id}', {
        params: { path: { id: 'dev-1' } },
        body: { group_id: 'grp-eng' },
      }),
    )
    expect(keepCurrent).toBeChecked()
  })

  it('shows a resolved state when the fetched device no longer has a conflict', async () => {
    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/devices/{id}')
        return Promise.resolve({ data: { ...mockDevice, open_alerts: [] } } as never)
      return Promise.resolve({ data: { items: [] } } as never)
    })
    renderDialog()

    expect(await screen.findByText('This conflict is already resolved.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('treats a resolve 404 as already resolved and closes the dialog', async () => {
    vi.spyOn(api, 'GET').mockResolvedValue({ data: { items: [] } } as never)
    vi.spyOn(api, 'POST').mockRejectedValue(new ApiError(404, 'not_found', 'alert not found'))
    const onOpenChange = vi.fn()
    renderDialog({ onOpenChange })
    fireEvent.click(screen.getByRole('radio', { name: /Keep where it is/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(await screen.findByText('Conflict already resolved')).toBeInTheDocument()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(screen.queryByText('Could not resolve conflict')).not.toBeInTheDocument()
  })

  it('replaces stale initial device data with the fetched device', async () => {
    const fetched = { ...mockDevice, alias: 'Fresh device', open_alerts: [] }
    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/devices/{id}') return Promise.resolve({ data: fetched } as never)
      return Promise.resolve({ data: { items: [] } } as never)
    })
    renderDialog({ initialDevice: mockDevice })

    expect(await screen.findByText('Fresh device')).toBeInTheDocument()
    expect(screen.getByText('This conflict is already resolved.')).toBeInTheDocument()
  })

  it('choosing Keep where it is sends POST /devices/{id}/alerts/{alert_id}/resolve with dismiss', async () => {
    vi.spyOn(api, 'GET').mockResolvedValue({ data: { items: [] } } as never)
    const resolveSpy = vi
      .spyOn(api, 'POST')
      .mockResolvedValue({ data: { ...mockDevice, open_alerts: [] } } as never)
    const onOpenChange = vi.fn()

    renderDialog({ onOpenChange })

    // Select 'Keep where it is'
    const keepRadio = screen.getByRole('radio', { name: /Keep where it is/i })
    fireEvent.click(keepRadio)

    const applyBtn = screen.getByRole('button', { name: 'Apply' })
    fireEvent.click(applyBtn)

    await waitFor(() => {
      expect(resolveSpy).toHaveBeenCalledWith(
        '/admin/api/v1/devices/{id}/alerts/{alert_id}/resolve',
        {
          params: { path: { id: 'dev-1', alert_id: 'alert-conflict-1' } },
          body: { action: 'dismiss' },
        },
      )
    })

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it('GlobalGroupConflictDialog opens when openGroupConflictDialog is triggered', async () => {
    vi.spyOn(api, 'GET').mockResolvedValue({ data: { items: [] } } as never)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <TooltipProvider>
            <GlobalGroupConflictDialog />
          </TooltipProvider>
        </ToasterProvider>
      </QueryClientProvider>,
    )

    expect(screen.queryByText('Resolve Group Conflict')).not.toBeInTheDocument()

    act(() => {
      openGroupConflictDialog({ deviceId: 'dev-1', initialDevice: mockDevice })
    })

    await waitFor(() => {
      expect(screen.getByText('Resolve Group Conflict')).toBeInTheDocument()
    })
  })
})
