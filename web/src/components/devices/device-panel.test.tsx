import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import type { components } from '@/api/schema'
import { ToasterProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { OverlayFocusProvider } from '@/components/ui/use-overlay-focus'
import { DevicePanel } from './device-panel'

vi.setConfig({ testTimeout: 15_000 })

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

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 'dev-1',
    rustdesk_id: '111222333',
    uuid: 'uuid-1',
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

const DEVICES: Record<string, Device> = {
  'dev-1': makeDevice({ id: 'dev-1', rustdesk_id: '111222333', alias: 'Office PC' }),
  'dev-2': makeDevice({ id: 'dev-2', rustdesk_id: '444555666', alias: 'Lab Workstation' }),
}

function mockApi() {
  vi.spyOn(api, 'GET').mockImplementation((path: string, opts?: unknown) => {
    const params = (opts as { params?: { path?: { id?: string }; query?: { q?: string } } })?.params
    if (path === '/admin/api/v1/devices/{id}') {
      const id = params?.path?.id ?? ''
      const dev = DEVICES[id]
      if (!dev) return Promise.reject(new Error(`Missing device ${id}`))
      return Promise.resolve({ response: new Response(), data: dev } as never)
    }
    if (path === '/admin/api/v1/devices') {
      const q = (params?.query?.q ?? '').toLowerCase()
      const items = Object.values(DEVICES).filter((d) => d.rustdesk_id.toLowerCase().includes(q))
      return Promise.resolve({
        response: new Response(),
        data: { items, next_cursor: '' },
      } as never)
    }
    if (path === '/admin/api/v1/devices/{id}/policy') {
      return Promise.resolve({
        response: new Response(),
        data: { connect: 'unrestricted', status: 'applied' },
      } as never)
    }
    if (path === '/admin/api/v1/devices/{id}/id-allow-list') {
      const id = params?.path?.id ?? ''
      const ids = id === 'dev-1' ? ['444555666'] : []
      return Promise.resolve({
        response: new Response(),
        data: { ids, effective: [] },
      } as never)
    }
    if (path === '/admin/api/v1/groups' || path === '/admin/api/v1/tags') {
      return Promise.resolve({
        response: new Response(),
        data: { items: [], next_cursor: '' },
      } as never)
    }
    if (path === '/admin/api/v1/sessions' || path === '/admin/api/v1/audit') {
      return Promise.resolve({
        response: new Response(),
        data: { items: [], next_cursor: '' },
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
}

function renderPanel(initialEntries: string[]) {
  mockApi()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const history = createMemoryHistory({ initialEntries })
  const rootRoute = createRootRoute({
    validateSearch: (search: Record<string, unknown>) => {
      const out: { device?: string; from?: string } = {}
      if (typeof search.device === 'string' && search.device) out.device = search.device
      if (
        typeof search.from === 'string' &&
        search.from &&
        out.device &&
        search.from !== out.device
      )
        out.from = search.from
      return out
    },
    component: () => (
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <TooltipProvider>
            <OverlayFocusProvider>
              <DevicePanel />
            </OverlayFocusProvider>
          </TooltipProvider>
        </ToasterProvider>
      </QueryClientProvider>
    ),
  })
  const router = createRouter({ routeTree: rootRoute, history })
  const view = render(<RouterProvider router={router} />)
  return { ...view, client, history, router }
}

describe('DevicePanel back navigation and cleanup', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows no back link without from, and shows it after opening from an allowed-ID chip', async () => {
    const { router } = renderPanel(['/devices?device=dev-1'])
    expect(
      await screen.findByRole('heading', { name: 'Office PC' }, { timeout: 5_000 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Back to/ })).not.toBeInTheDocument()

    const chip = await screen.findByText('444555666', undefined, { timeout: 5_000 })
    fireEvent.mouseEnter(chip)
    expect(await screen.findByText('Lab Workstation')).toBeInTheDocument()

    const backSpy = vi.spyOn(router.history, 'back')
    fireEvent.click(screen.getByRole('link', { name: '444555666' }))

    await waitFor(() =>
      expect(router.state.location.search).toEqual({ device: 'dev-2', from: 'dev-1' }),
    )
    expect(
      await screen.findByRole('heading', { name: 'Lab Workstation' }, { timeout: 5_000 }),
    ).toBeInTheDocument()

    const backLink = await screen.findByRole('link', { name: '← Back to Office PC' })
    fireEvent.click(backLink)

    expect(backSpy).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(router.state.location.search).toEqual({ device: 'dev-1' }))
    expect(
      await screen.findByRole('heading', { name: 'Office PC' }, { timeout: 5_000 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Back to/ })).not.toBeInTheDocument()
  })

  it('navigates to ?device=<from> when opened directly without a matching previous history entry', async () => {
    const { router } = renderPanel(['/devices?device=dev-2&from=dev-1'])
    expect(
      await screen.findByRole('heading', { name: 'Lab Workstation' }, { timeout: 5_000 }),
    ).toBeInTheDocument()

    const backSpy = vi.spyOn(router.history, 'back')
    const backLink = await screen.findByRole('link', { name: '← Back to Office PC' })
    fireEvent.click(backLink)

    expect(backSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(router.state.location.search).toEqual({ device: 'dev-1' }))
    expect(
      await screen.findByRole('heading', { name: 'Office PC' }, { timeout: 5_000 }),
    ).toBeInTheDocument()
  })

  it('clears both device and from when closing via ×, Escape, or overlay', async () => {
    // 1. Close via ×
    const first = renderPanel(['/devices?device=dev-2&from=dev-1'])
    await screen.findByRole('heading', { name: 'Lab Workstation' }, { timeout: 5_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Close device details' }))
    await waitFor(() => expect(first.router.state.location.search).toEqual({}))
    cleanup()

    // 2. Close via Escape
    const second = renderPanel(['/devices?device=dev-2&from=dev-1'])
    await screen.findByRole('heading', { name: 'Lab Workstation' }, { timeout: 5_000 })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(second.router.state.location.search).toEqual({}))
    cleanup()

    // 3. Close via overlay click
    const third = renderPanel(['/devices?device=dev-2&from=dev-1'])
    await screen.findByRole('heading', { name: 'Lab Workstation' }, { timeout: 5_000 })
    const overlay = document.querySelector('[data-slot="sheet-overlay"]')!
    fireEvent.pointerDown(overlay)
    fireEvent.click(overlay)
    await waitFor(() => expect(third.router.state.location.search).toEqual({}))
  })

  it('closes an open hover card on Escape without closing the DevicePanel', async () => {
    const { router } = renderPanel(['/devices?device=dev-1'])
    await screen.findByRole('heading', { name: 'Office PC' }, { timeout: 5_000 })
    const chip = await screen.findByText('444555666', undefined, { timeout: 5_000 })
    fireEvent.focus(chip)
    expect(await screen.findByText('Lab Workstation')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByText('444555666'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Lab Workstation')).not.toBeInTheDocument())
    expect(router.state.location.search).toEqual({ device: 'dev-1' })
    expect(screen.getByRole('heading', { name: 'Office PC' })).toBeInTheDocument()
  })
})
