import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import type { components } from '@/api/schema'
import { ToasterProvider } from '@/components/ui/toast'
import * as groupConflictDialog from './group-conflict-dialog'
import { useApproveDevices } from './use-approve-devices'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('offers Undo for one approved device with its name', async () => {
  const device = {
    id: 'one',
    alias: 'Reception',
    hostname: 'desk',
    rustdesk_id: '123',
  } as components['schemas']['Device']
  const post = vi.spyOn(api, 'POST').mockResolvedValue({ data: device } as never)
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <ToasterProvider>{children}</ToasterProvider>
    </QueryClientProvider>
  )
  const { result } = renderHook(() => useApproveDevices(), { wrapper })
  await act(async () => {
    await result.current.approve([device])
  })
  expect(screen.getByText('Device approved')).toBeTruthy()
  expect(screen.getByText('Reception')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/admin/api/v1/devices/{id}/reopen', {
      params: { path: { id: 'one' } },
    }),
  )
})

it('offers one Undo for every device in a bulk approval', async () => {
  const devices = ['one', 'two'].map(
    (id) => ({ id, alias: id, hostname: '', rustdesk_id: id }) as components['schemas']['Device'],
  )
  const post = vi
    .spyOn(api, 'POST')
    .mockImplementation(
      async (_path, init) =>
        ({ data: devices.find((d) => d.id === init?.params?.path?.id) }) as never,
    )
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <ToasterProvider>{children}</ToasterProvider>
    </QueryClientProvider>
  )
  const { result } = renderHook(() => useApproveDevices(), { wrapper })
  await act(async () => {
    await result.current.approve(devices)
  })
  expect(screen.getByText('2 devices approved')).toBeTruthy()
  expect(screen.getByText('0 placed in groups, 0 need a group choice')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await waitFor(() =>
    expect(
      post.mock.calls.filter(([path]) => path === '/admin/api/v1/devices/{id}/reopen'),
    ).toHaveLength(2),
  )
})

it('single approval with group_conflict alert opens resolution window', async () => {
  const openConflictSpy = vi.spyOn(groupConflictDialog, 'openGroupConflictDialog')
  const device = {
    id: 'conflicted-dev',
    alias: 'Frontdesk',
    hostname: 'desk-01',
    rustdesk_id: '999',
  } as components['schemas']['Device']

  const approvedDevice = {
    ...device,
    state: 'approved',
    open_alerts: [
      {
        id: 'alert-1',
        kind: 'group_conflict',
        groups: [{ id: 'grp-1', name: 'Group 1' }],
      },
    ],
  }

  vi.spyOn(api, 'POST').mockResolvedValue({ data: approvedDevice } as never)
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <ToasterProvider>{children}</ToasterProvider>
    </QueryClientProvider>
  )
  const { result } = renderHook(() => useApproveDevices(), { wrapper })
  await act(async () => {
    await result.current.approve([device])
  })

  expect(openConflictSpy).toHaveBeenCalledWith({
    deviceId: 'conflicted-dev',
    initialDevice: approvedDevice,
  })
})

it('mass approval with group_conflict alert does not open resolution window', async () => {
  const openConflictSpy = vi.spyOn(groupConflictDialog, 'openGroupConflictDialog')
  const devices = ['d1', 'd2'].map(
    (id) => ({ id, alias: id, hostname: '', rustdesk_id: id }) as components['schemas']['Device'],
  )

  vi.spyOn(api, 'POST').mockImplementation(async (_path, init) => {
    const id = init?.params?.path?.id
    return {
      data: {
        id,
        alias: id,
        hostname: '',
        rustdesk_id: id,
        state: 'approved',
        open_alerts: [
          {
            id: `alert-${id}`,
            kind: 'group_conflict',
            groups: [{ id: 'grp-1', name: 'Group 1' }],
          },
        ],
      },
    } as never
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <ToasterProvider>{children}</ToasterProvider>
    </QueryClientProvider>
  )
  const { result } = renderHook(() => useApproveDevices(), { wrapper })
  await act(async () => {
    await result.current.approve(devices)
  })

  expect(openConflictSpy).not.toHaveBeenCalled()
})

it('reports group placed and conflict counts in toast description for 2+ devices', async () => {
  const dev1 = {
    id: 'd1',
    alias: 'Dev1',
    hostname: 'host-1',
    rustdesk_id: '1',
    group_id: null,
  } as components['schemas']['Device']
  const dev2 = {
    id: 'd2',
    alias: 'Dev2',
    hostname: 'host-2',
    rustdesk_id: '2',
    group_id: null,
  } as components['schemas']['Device']

  vi.spyOn(api, 'POST').mockImplementation(async (path, init) => {
    if (path === '/admin/api/v1/devices/{id}/approve') {
      const id = init?.params?.path?.id
      if (id === 'd1') {
        return { data: { ...dev1, state: 'approved', group_id: 'grp-eng' } } as never
      }
      return {
        data: {
          ...dev2,
          state: 'approved',
          group_id: null,
          open_alerts: [{ id: 'a1', kind: 'group_conflict', groups: [{ id: 'g1', name: 'G1' }] }],
        },
      } as never
    }
    return { data: {} } as never
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <ToasterProvider>{children}</ToasterProvider>
    </QueryClientProvider>
  )
  const { result } = renderHook(() => useApproveDevices(), { wrapper })
  await act(async () => {
    await result.current.approve([dev1, dev2])
  })

  expect(screen.getByText('2 devices approved')).toBeTruthy()
  expect(screen.getByText('1 placed in groups, 1 need a group choice')).toBeTruthy()
})
