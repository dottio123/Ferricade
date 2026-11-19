import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { components } from '@/api/schema'
import { DeviceDetail } from './device-detail'
import { api } from '@/api/client'
import { ApiError } from '@/api/errors'
import { queryKeys } from '@/lib/queryKeys'
import type { AuditEvent } from '@/features/audit/describe'

type Device = components['schemas']['Device']

vi.mock('@/auth/role', () => ({
  useRole: vi.fn(() => 'owner'),
}))

vi.mock('./device-policy-section', () => ({
  DevicePolicySection: ({ deviceId }: { deviceId: string }) => (
    <div data-slot="mock-device-policy-section" data-device-id={deviceId}>
      Mock Policy Section
    </div>
  ),
}))

import { useRole } from '@/auth/role'

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 'dev-1',
    rustdesk_id: '123456789',
    uuid: 'uuid-pinned-1',
    state: 'approved',
    alias: 'Office PC',
    hostname: 'office-pc',
    os: 'Windows 11',
    cpu: 'Intel i7',
    memory: '16GB',
    client_version: '1.5.0',
    username: 'alice',
    note: '',
    group_id: null,
    first_seen_at: '2026-10-01T12:00:00Z',
    last_seen_at: '2026-10-19T12:00:00Z',
    approved_by: 'owner-id',
    approved_at: '2026-10-01T12:00:00Z',
    updated_at: '2026-10-19T12:00:00Z',
    tags: [],
    open_alerts: [],
    online: true,
    conns: [],
    ...overrides,
  }
}

import { ToasterProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import * as groupConflictDialog from './group-conflict-dialog'

function renderDeviceDetail(
  device: Device,
  role = 'owner',
  policy = { connect: 'unrestricted', status: 'applied' },
  auditItems: AuditEvent[] = [],
) {
  vi.mocked(useRole).mockReturnValue(role as 'owner' | 'admin' | 'user')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  vi.spyOn(api, 'GET').mockImplementation((path: string) => {
    if (path === '/admin/api/v1/devices/{id}') {
      return Promise.resolve({ response: new Response(), data: device } as never)
    }
    if (path === '/admin/api/v1/devices/{id}/policy') {
      return Promise.resolve({ response: new Response(), data: { ...policy } } as never)
    }
    if (path === '/admin/api/v1/devices/{id}/id-allow-list') {
      return Promise.resolve({
        response: new Response(),
        data: { ids: [], effective: [] },
      } as never)
    }
    if (path === '/admin/api/v1/groups') {
      return Promise.resolve({
        response: new Response(),
        data: { items: [], next_cursor: '' },
      } as never)
    }
    if (path === '/admin/api/v1/tags') {
      return Promise.resolve({
        response: new Response(),
        data: { items: [], next_cursor: '' },
      } as never)
    }
    if (path === '/admin/api/v1/sessions') {
      return Promise.resolve({
        response: new Response(),
        data: { items: [], next_cursor: '' },
      } as never)
    }
    if (path === '/admin/api/v1/audit') {
      return Promise.resolve({
        response: new Response(),
        data: { items: auditItems, next_cursor: '' },
      } as never)
    }
    if (path === '/admin/api/v1/me/preferences') {
      return Promise.resolve({
        response: new Response(),
        data: {
          pinned_device_ids: [],
          preset: 'business',
          theme: 'system',
          palette: 'default',
          density: 'comfortable',
          modules: [],
        },
      } as never)
    }
    return Promise.reject(new Error(`Unhandled GET ${path}`))
  })

  const view = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToasterProvider>
          <DeviceDetail deviceId={device.id} />
        </ToasterProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  )

  return { ...view, client }
}

describe('DeviceDetail Policy Section & Alerts', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders audit conflict counts after the group description', async () => {
    renderDeviceDetail(makeDevice(), 'owner', undefined, [
      {
        id: 'audit-1',
        at: '2026-10-24T12:00:00Z',
        actor_user_id: 'owner-id',
        actor_ip: '192.168.1.1',
        action: 'group.rule_removed',
        target_type: 'group',
        target_id: 'group-1',
        details: { pattern: 'w-*', conflicts_resolved: ['device-1'] },
      },
    ])

    expect(
      await screen.findByText('removed the pattern `w-*` from group (1 conflict resolved)'),
    ).toBeInTheDocument()
  })

  it('disables locked Connect, shows policy notes, and follows a policy refetch', async () => {
    const policy = { connect: 'locked', status: 'pending' }
    const { client } = renderDeviceDetail(makeDevice(), 'user', policy)
    const button = await screen.findByRole('button', { name: 'Connect' })
    await waitFor(() => expect(button).toBeDisabled())
    expect(screen.getByText('Locked by policy. Allow access first.')).toBeInTheDocument()
    expect(button).toHaveAttribute('title', 'Locked by policy. Allow access first.')
    policy.connect = 'attended'
    await client.invalidateQueries({ queryKey: queryKeys.devicePolicy('dev-1') })
    await waitFor(() => expect(button).toBeEnabled())
    expect(screen.getByText('Someone at the device must accept.')).toBeInTheDocument()
    policy.connect = 'window'
    await client.invalidateQueries({ queryKey: queryKeys.devicePolicy('dev-1') })
    await waitFor(() => expect(screen.getByText('Applying access…')).toBeInTheDocument())
  })

  it('shows a stale access_locked response and refetches policy status', async () => {
    const policy = { connect: 'attended', status: 'applied' }
    const get = vi.spyOn(api, 'GET')
    const { client } = renderDeviceDetail(makeDevice(), 'owner', policy)
    const button = await screen.findByRole('button', { name: 'Connect' })
    await waitFor(() => expect(button).toBeEnabled())
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    get.mockImplementationOnce(() =>
      Promise.reject(
        new ApiError(409, 'access_locked' as never, 'Locked by policy. Allow access first.'),
      ),
    )
    fireEvent.click(button)
    await waitFor(() =>
      expect(screen.getByText('Locked by policy. Allow access first.')).toBeInTheDocument(),
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.devicePolicy('dev-1') })
  })

  it('renders policy section for approved device and hides it for other states', async () => {
    // 1. approved
    renderDeviceDetail(makeDevice({ state: 'approved' }))
    await waitFor(() => {
      expect(screen.getByText('Mock Policy Section')).toBeInTheDocument()
    })
    cleanup()

    // 2. pending
    renderDeviceDetail(makeDevice({ state: 'pending' }))
    await waitFor(() => {
      expect(screen.getByText('pending')).toBeInTheDocument()
    })
    expect(screen.queryByText('Mock Policy Section')).toBeNull()
    cleanup()

    // 3. rejected
    renderDeviceDetail(makeDevice({ state: 'rejected' }))
    await waitFor(() => {
      expect(screen.getByText('rejected')).toBeInTheDocument()
    })
    expect(screen.queryByText('Mock Policy Section')).toBeNull()
    cleanup()

    // 4. archived
    renderDeviceDetail(makeDevice({ state: 'archived' }))
    await waitFor(() => {
      expect(screen.getByText('archived')).toBeInTheDocument()
    })
    expect(screen.queryByText('Mock Policy Section')).toBeNull()
  })

  it('renders access_window_unconfirmed alert with Dismiss only and sends dismiss', async () => {
    const postSpy = vi.spyOn(api, 'POST').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/devices/{id}/alerts/{alert_id}/resolve') {
        return Promise.resolve({ response: new Response(), data: makeDevice() } as never)
      }
      return Promise.reject(new Error(`Unhandled POST ${path}`))
    })

    const closedAt = '2026-10-19T14:30:00Z'
    const timeStr = new Date(closedAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })

    renderDeviceDetail(
      makeDevice({
        open_alerts: [
          {
            id: 'alert-unconfirmed-1',
            kind: 'access_window_unconfirmed',
            groups: [],
            seen_uuid: null,
            ip: null,
            created_at: closedAt,
            window_closed_at: closedAt,
          },
        ],
      }),
    )

    await waitFor(() => {
      expect(screen.getByText('Access window not confirmed closed')).toBeInTheDocument()
      expect(
        screen.getByText(
          `Window closed at ${timeStr}; the device has not confirmed the baseline settings.`,
        ),
      ).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept new uuid' })).toBeNull()

    // Click Dismiss
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        '/admin/api/v1/devices/{id}/alerts/{alert_id}/resolve',
        expect.objectContaining({
          params: { path: { id: 'dev-1', alert_id: 'alert-unconfirmed-1' } },
          body: { action: 'dismiss' },
        }),
      )
    })
  })

  it('renders uuid_mismatch alert with Dismiss and Accept new uuid', async () => {
    renderDeviceDetail(
      makeDevice({
        open_alerts: [
          {
            id: 'alert-uuid-1',
            kind: 'uuid_mismatch',
            groups: [],
            seen_uuid: 'uuid-seen-2',
            ip: '192.168.1.100',
            created_at: '2026-10-19T10:00:00Z',
            window_closed_at: null,
          },
        ],
      }),
    )

    await waitFor(() => {
      expect(screen.getByText('Client UUID Mismatch')).toBeInTheDocument()
      expect(screen.getByText('uuid-seen-2')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept new uuid' })).toBeInTheDocument()
  })

  it('shows window_open error message when deleting a device with an open window', async () => {
    vi.spyOn(api, 'DELETE').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/devices/{id}') {
        return Promise.reject(new ApiError(409, 'window_open', 'close the access window first'))
      }
      return Promise.reject(new Error(`Unhandled DELETE ${path}`))
    })

    renderDeviceDetail(makeDevice({ state: 'approved' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete device' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Delete device' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('close the access window first')
    })
  })

  it('renders group_conflict alert and clicking resolve button opens resolution window', async () => {
    const openConflictSpy = vi.spyOn(groupConflictDialog, 'openGroupConflictDialog')

    const dev = makeDevice({
      open_alerts: [
        {
          id: 'alert-gc-1',
          kind: 'group_conflict',
          groups: [
            { id: 'g1', name: 'Engineering' },
            { id: 'g2', name: 'Support' },
          ],
          seen_uuid: null,
          ip: null,
          created_at: '2026-10-22T10:00:00Z',
          window_closed_at: null,
        },
      ],
    })

    renderDeviceDetail(dev)

    await waitFor(() => {
      expect(screen.getByText('Group Conflict')).toBeInTheDocument()
      expect(screen.getByText('Engineering, Support')).toBeInTheDocument()
    })

    const resolveBtn = screen.getByRole('button', { name: /Resolve conflict/i })
    expect(resolveBtn).toBeInTheDocument()
    fireEvent.click(resolveBtn)

    expect(openConflictSpy).toHaveBeenCalledWith({
      deviceId: dev.id,
      initialDevice: expect.objectContaining({ id: dev.id }),
    })
  })
})
