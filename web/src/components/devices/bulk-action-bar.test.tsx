import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Device } from './bulk-action-bar'
import { formatSkippedReason } from './bulk-action-bar'

function makeDevice(id: string, state: Device['state']): Device {
  return {
    id,
    rustdesk_id: `id-${id}`,
    uuid: `uuid-${id}`,
    state,
    online: false,
    tags: [],
    created_at: '2026-10-06T12:00:00Z',
    updated_at: '2026-10-06T12:00:00Z',
  } as unknown as Device
}

describe('formatSkippedReason', () => {
  it('formats single skipped device reason per state for approve', () => {
    const skippedArchived = [makeDevice('1', 'archived')]
    expect(formatSkippedReason(skippedArchived, 'approve')).toBe('archived')

    const skippedApproved = [makeDevice('2', 'approved')]
    expect(formatSkippedReason(skippedApproved, 'approve')).toBe('already approved')
  })

  it('formats multiple skipped devices with counts when states differ', () => {
    const skippedMixed = [makeDevice('1', 'archived'), makeDevice('2', 'approved')]
    expect(formatSkippedReason(skippedMixed, 'approve')).toBe('1 archived, 1 already approved')
  })

  it('formats homogeneous multiple skipped devices', () => {
    const skippedTwoArchived = [makeDevice('1', 'archived'), makeDevice('2', 'archived')]
    expect(formatSkippedReason(skippedTwoArchived, 'approve')).toBe('archived')
  })

  it('formats tag skip reasons', () => {
    const tag = { id: 'tag-1', name: 'servers', color: 123 }
    const dev = [makeDevice('1', 'approved')]
    expect(formatSkippedReason(dev, 'addTag', tag)).toBe('already tagged servers')
    expect(formatSkippedReason(dev, 'removeTag', tag)).toBe('did not have tag servers')
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '@/api/client'
import { ApiError } from '@/api/errors'
import { ToasterProvider } from '@/components/ui/toast'
import { queryKeys } from '@/lib/queryKeys'
import * as groupConflictDialog from './group-conflict-dialog'
import { BulkActionBar } from './bulk-action-bar'

describe('BulkActionBar window_open refusals', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('surfaces 409 window_open message when bulk archive fails', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const dev = makeDevice('dev-window-1', 'approved')

    vi.spyOn(api, 'POST').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/devices/{id}/archive') {
        return Promise.reject(new ApiError(409, 'window_open', 'close the access window first'))
      }
      return Promise.reject(new Error(`Unhandled POST ${path}`))
    })

    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <BulkActionBar selectedDevices={[dev]} tags={[]} onClearSelection={() => {}} />
        </ToasterProvider>
      </QueryClientProvider>,
    )

    const archiveBtn = screen.getByRole('button', { name: /Archive/i })
    fireEvent.click(archiveBtn)

    await waitFor(() => {
      expect(
        screen.getByText((content) => content.includes('close the access window first')),
      ).toBeInTheDocument()
    })
  })
})

describe('BulkActionBar Move to Group and Delete', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const mockGroups = [
    {
      id: 'grp-eng',
      name: 'Engineering',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'pol-1',
      children: [],
    },
  ]

  it('Move to group warns about policy and sends PATCH per device', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const dev1 = makeDevice('dev-1', 'approved')
    const dev2 = makeDevice('dev-2', 'pending')

    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({ data: { items: mockGroups } } as never)
      }
      return Promise.reject(new Error(`Unhandled GET ${path}`))
    })

    const patchSpy = vi.spyOn(api, 'PATCH').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/devices/{id}') {
        return Promise.resolve({ data: {} } as never)
      }
      return Promise.reject(new Error(`Unhandled PATCH ${path}`))
    })

    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <BulkActionBar selectedDevices={[dev1, dev2]} tags={[]} onClearSelection={() => {}} />
        </ToasterProvider>
      </QueryClientProvider>,
    )

    const moveBtn = screen.getByRole('button', { name: /Move to group/i })
    fireEvent.click(moveBtn)

    // Check dialog opens and warning text is present
    await waitFor(() => {
      expect(screen.getByText('Move to Group')).toBeInTheDocument()
      expect(
        screen.getByText(
          (content) =>
            content.includes('2 devices will move to') &&
            content.includes('and take its client policy.'),
        ),
      ).toBeInTheDocument()
    })

    // Click group picker trigger
    const pickerTrigger = screen.getByRole('button', { name: /Select a group…/i })
    fireEvent.click(pickerTrigger)

    // Select Engineering
    await waitFor(() => {
      expect(screen.getByText('Engineering')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Engineering'))

    // Click confirm
    const confirmMoveBtn = screen.getByRole('button', { name: 'Move devices' })
    fireEvent.click(confirmMoveBtn)

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledTimes(2)
      expect(patchSpy).toHaveBeenCalledWith('/admin/api/v1/devices/{id}', {
        params: { path: { id: 'dev-1' } },
        body: { group_id: 'grp-eng' },
      })
      expect(patchSpy).toHaveBeenCalledWith('/admin/api/v1/devices/{id}', {
        params: { path: { id: 'dev-2' } },
        body: { group_id: 'grp-eng' },
      })
    })

    await waitFor(() => {
      expect(screen.getByText(/Moved 2 of 2/i)).toBeInTheDocument()
    })
  })

  it('Delete warns about session history, sends DELETE, and reports 409 window_open', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const dev1 = makeDevice('dev-1', 'approved')
    const dev2 = makeDevice('dev-2', 'approved')

    const deleteSpy = vi
      .spyOn(api, 'DELETE')
      .mockImplementation((_path: string, init?: { params?: { path?: { id?: string } } }) => {
        if (init?.params?.path?.id === 'dev-1') {
          return Promise.reject(new ApiError(409, 'window_open', 'close the access window first'))
        }
        return Promise.resolve({ data: {} } as never)
      })

    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <BulkActionBar selectedDevices={[dev1, dev2]} tags={[]} onClearSelection={() => {}} />
        </ToasterProvider>
      </QueryClientProvider>,
    )

    const deleteBtn = screen.getByRole('button', { name: /Delete \(2\)/i })
    fireEvent.click(deleteBtn)

    // Check warning text in dialog
    await waitFor(() => {
      expect(
        screen.getByText((content) =>
          content.includes('Delete 2 devices? Their session history is deleted too.'),
        ),
      ).toBeInTheDocument()
    })

    // Click Delete in modal
    const confirmDeleteBtn = screen.getByRole('button', { name: 'Delete' })
    fireEvent.click(confirmDeleteBtn)

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledTimes(2)
      expect(
        screen.getByText((content) => content.includes('close the access window first')),
      ).toBeInTheDocument()
    })
  })

  it('Mass approval reports placed in groups and need a group choice counts without opening conflict dialog', async () => {
    const openConflictSpy = vi.spyOn(groupConflictDialog, 'openGroupConflictDialog')
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const dev1 = makeDevice('dev-p1', 'pending')
    const dev2 = makeDevice('dev-p2', 'pending')

    vi.spyOn(api, 'POST').mockImplementation(
      (path: string, init?: { params?: { path?: { id?: string } } }) => {
        if (path === '/admin/api/v1/devices/{id}/approve') {
          const id = init?.params?.path?.id
          if (id === 'dev-p1') {
            return Promise.resolve({
              data: {
                ...dev1,
                state: 'approved',
                group_id: 'grp-eng',
                open_alerts: [],
              },
            } as never)
          }
          return Promise.resolve({
            data: {
              ...dev2,
              state: 'approved',
              group_id: null,
              open_alerts: [
                {
                  id: 'alert-gc',
                  kind: 'group_conflict',
                  groups: [
                    { id: 'g1', name: 'G1' },
                    { id: 'g2', name: 'G2' },
                  ],
                },
              ],
            },
          } as never)
        }
        return Promise.reject(new Error(`Unhandled POST ${path}`))
      },
    )

    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <BulkActionBar selectedDevices={[dev1, dev2]} tags={[]} onClearSelection={() => {}} />
        </ToasterProvider>
      </QueryClientProvider>,
    )

    const approveBtn = screen.getByRole('button', { name: /Approve \(2\)/i })
    fireEvent.click(approveBtn)

    // Confirm modal
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve 2' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Approve 2' }))

    await waitFor(() => {
      expect(screen.getByText('1 placed in groups, 1 need a group choice')).toBeInTheDocument()
    })

    expect(openConflictSpy).not.toHaveBeenCalled()
  })

  it('Users do not see Move to Group or Delete', () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    client.setQueryData(queryKeys.me(), {
      user: { id: 'u1', username: 'user1', role: 'user' },
    })
    const dev = makeDevice('dev-1', 'approved')

    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <BulkActionBar selectedDevices={[dev]} tags={[]} onClearSelection={() => {}} />
        </ToasterProvider>
      </QueryClientProvider>,
    )

    expect(screen.queryByRole('button', { name: /Move to group/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Delete/i })).toBeNull()
  })
})

describe('BulkActionBar queue', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })
  it('keeps select-all, queue labels and only approve/reject actions', () => {
    const get = vi.spyOn(api, 'GET').mockRejectedValue(new Error('Unexpected queue query'))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const devices = [makeDevice('queue-1', 'pending')]
    const toggle = vi.fn()
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <BulkActionBar
            selectedDevices={[]}
            tags={[]}
            onClearSelection={() => {}}
            queue={{
              devices,
              selectedCount: 0,
              allSelected: false,
              onToggleSelectAll: toggle,
              onRunningChange: () => {},
            }}
          />
        </ToasterProvider>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible devices' }))
    expect(get).not.toHaveBeenCalled()
    expect(toggle).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Approve all (1)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject all (1)' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Delete|Move to group|Archive/ }),
    ).not.toBeInTheDocument()
  })
})
