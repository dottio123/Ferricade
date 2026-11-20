import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { api } from '@/api/client'
import type { components } from '@/api/schema'
import { ToasterProvider } from '@/components/ui/toast'
import { IdAllowListEditor } from './id-allow-list-editor'

vi.setConfig({ testTimeout: 15_000 })

type Device = components['schemas']['Device']

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    rustdesk_id: 'Office_123',
    uuid: 'uuid-1',
    state: 'approved',
    alias: 'Reception Desk',
    hostname: 'reception-pc',
    os: 'Windows 11',
    cpu: 'Intel i5',
    memory: '16GB',
    client_version: '1.5.0',
    username: 'alex',
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

function renderEditorWithRouter(
  props: Partial<React.ComponentProps<typeof IdAllowListEditor>> = {},
  initialEntries = ['/settings/id-allow-list'],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const history = createMemoryHistory({ initialEntries })
  const rootRoute = createRootRoute({
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => (
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <IdAllowListEditor title="ID allow list" ids={[]} onSave={vi.fn()} {...props} />
        </ToasterProvider>
      </QueryClientProvider>
    ),
  })
  const router = createRouter({ routeTree: rootRoute, history })
  const view = render(<RouterProvider router={router} />)
  return { ...view, client, history, router }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderEditor(props: Partial<React.ComponentProps<typeof IdAllowListEditor>> = {}) {
  vi.spyOn(api, 'GET').mockResolvedValue({
    response: new Response(),
    data: { items: [], next_cursor: '' },
  } as never)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ToasterProvider>
        <IdAllowListEditor title="ID allow list" ids={[]} onSave={vi.fn()} {...props} />
      </ToasterProvider>
    </QueryClientProvider>,
  )
}

describe('IdAllowListEditor', () => {
  it('searches enrolled devices only after nonblank input settles', async () => {
    vi.useRealTimers()
    const get = vi.spyOn(api, 'GET').mockResolvedValue({
      response: new Response(),
      data: { items: [], next_cursor: '' },
    } as never)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <IdAllowListEditor title="ID allow list" ids={[]} onSave={vi.fn()} />
        </ToasterProvider>
      </QueryClientProvider>,
    )
    expect(get).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Add RustDesk ID' }), {
      target: { value: '  office  ' },
    })
    await new Promise((resolve) => setTimeout(resolve, 350))
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        '/admin/api/v1/devices',
        expect.objectContaining({
          params: { query: { limit: 200, q: 'office' } },
        }),
      ),
    )
  })

  it('adds with Enter or Add and removes an ID', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderEditor({ ids: ['Office_123'], onSave })

    fireEvent.click(screen.getByRole('button', { name: 'Remove Office_123' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Add RustDesk ID' }), {
      target: { value: 'Laptop_123' },
    })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Add RustDesk ID' }), {
      key: 'Enter',
    })
    expect(screen.getByText('Laptop_123')).toBeInTheDocument()
    expect(screen.queryByText('Office_123')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save ID allow list' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['Laptop_123']))
  })

  it('validates the API pattern, duplicate IDs, and server validation errors', async () => {
    const onSave = vi.fn().mockRejectedValue(new ApiError(400, 'validation_error', 'ID is invalid'))
    renderEditor({ onSave })
    const input = screen.getByRole('textbox', { name: 'Add RustDesk ID' })
    fireEvent.change(input, { target: { value: 'bad-id' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add ID' }))
    expect(screen.getByText(/6 to 16 letters/)).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'Office_123' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'office_123' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getAllByText(/Office_123/i)).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Save ID allow list' }))
    expect(await screen.findByText('ID is invalid')).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('disables editing while a save is pending', async () => {
    let finishSave!: () => void
    const onSave = vi.fn(() => new Promise<void>((resolve) => (finishSave = resolve)))
    renderEditor({ ids: ['Existing_1'], onSave })

    fireEvent.click(screen.getByRole('button', { name: 'Save ID allow list' }))
    const input = screen.getByRole('textbox', { name: 'Add RustDesk ID' })
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add ID' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove Existing_1' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save ID allow list' })).toBeDisabled()
    finishSave()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save ID allow list' })).toBeEnabled(),
    )
  })

  it('describes each editor error with its own element', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <div>
            <IdAllowListEditor title="First list" ids={[]} onSave={vi.fn()} />
            <IdAllowListEditor title="Second list" ids={[]} onSave={vi.fn()} />
          </div>
        </ToasterProvider>
      </QueryClientProvider>,
    )
    const [first, second] = screen.getAllByRole('textbox', { name: 'Add RustDesk ID' })
    fireEvent.change(first!, { target: { value: 'bad-id' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add ID' })[0]!)
    fireEvent.change(second!, { target: { value: 'Valid_123' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add ID' })[1]!)
    fireEvent.change(second!, { target: { value: 'valid_123' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add ID' })[1]!)

    const errors = screen.getAllByRole('alert')
    expect(errors).toHaveLength(2)
    expect(errors[1]).toHaveTextContent('already on the list')
    expect(first).toHaveAttribute('aria-describedby', errors[0]!.id)
    expect(second).toHaveAttribute('aria-describedby', errors[1]!.id)
    expect(errors[0]!.id).not.toBe(errors[1]!.id)
  })

  it('refuses a 201st ID', () => {
    renderEditor({ ids: Array.from({ length: 200 }, (_, index) => `Device_${index}`) })
    const input = screen.getByRole('textbox', { name: 'Add RustDesk ID' })
    fireEvent.change(input, { target: { value: 'Last_123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add ID' }))
    expect(screen.getByText('A list can contain at most 200 IDs.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(200)
  })

  it('groups effective entries under one heading per source, in order', () => {
    renderEditor({
      readOnly: true,
      effective: [
        { id: 'Global_1', source: 'global', group_id: null, group_name: null },
        { id: 'Shared_1', source: 'global', group_id: null, group_name: null },
        { id: 'Office_1', source: 'group', group_id: 'g1', group_name: 'Office' },
        { id: 'Lab_1', source: 'group', group_id: 'g2', group_name: 'Lab' },
        { id: 'Shared_1', source: 'group', group_id: 'g2', group_name: 'Lab' },
        { id: 'Device_1', source: 'device', group_id: null, group_name: null },
      ],
    })
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)
    expect(headings).toEqual(['This device', 'Group Office', 'Group Lab', 'Global'])
    const idsOf = (name: string) =>
      within(screen.getByRole('list', { name }))
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    expect(idsOf('This device')).toEqual(['Device_1'])
    expect(idsOf('Group Office')).toEqual(['Office_1'])
    expect(idsOf('Group Lab')).toEqual(['Lab_1', 'Shared_1'])
    expect(idsOf('Global')).toEqual(['Global_1', 'Shared_1'])
    // The source is the heading only: no label text sits beside a badge.
    for (const li of screen.getAllByRole('listitem')) {
      expect(li.textContent).not.toMatch(/Global$|This device|Group /)
    }
  })

  it('leaves out sources that have no IDs and says so when there are none', () => {
    const { unmount } = renderEditor({
      readOnly: true,
      effective: [{ id: 'Global_1', source: 'global', group_id: null, group_name: null }],
    })
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      'Global',
    ])
    expect(screen.queryByRole('list', { name: 'This device' })).not.toBeInTheDocument()
    unmount()
    renderEditor({ readOnly: true, effective: [] })
    expect(screen.queryAllByRole('heading', { level: 4 })).toHaveLength(0)
    expect(screen.getByText('No IDs')).toBeInTheDocument()
  })

  it('wraps a long unbroken group name on its heading', () => {
    const longGroup = 'G'.repeat(128)
    renderEditor({
      readOnly: true,
      effective: [{ id: 'Group_1', source: 'group', group_id: 'g1', group_name: longGroup }],
    })
    const heading = screen.getByRole('heading', { level: 4, name: `Group ${longGroup}` })
    expect(heading).toHaveClass('min-w-0', 'break-words')
  })
  it('shows no toast while pending or rejected, and exactly one after saving', async () => {
    let rejectSave!: (err: unknown) => void
    let resolveSave!: () => void
    const onSave = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((_, rej) => (rejectSave = rej)))
      .mockImplementationOnce(() => new Promise<void>((res) => (resolveSave = res)))
    renderEditor({ ids: ['Office_123'], onSave })

    fireEvent.click(screen.getByRole('button', { name: 'Save ID allow list' }))
    expect(screen.queryByText('ID allow list saved')).toBeNull()
    rejectSave(new Error('Save failed'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('ID allow list saved')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Save ID allow list' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('ID allow list saved')).toBeNull()
    resolveSave()
    expect(await screen.findAllByText('ID allow list saved')).toHaveLength(1)
  })

  it('looks up allowed ID lazily on hover, matches case-insensitively, and renders device details', async () => {
    const devA = makeDevice({
      id: 'dev-office',
      rustdesk_id: 'Office_123',
      alias: 'Reception Desk',
      username: 'alex',
      state: 'pending',
      online: true,
      group_id: 'grp-1',
    })
    const otherDev = makeDevice({
      id: 'dev-other',
      rustdesk_id: 'office_1234',
      alias: 'Other Desk',
      username: 'other',
    })
    const get = vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/devices') {
        return Promise.resolve({
          response: new Response(),
          data: { items: [otherDev, devA], next_cursor: '' },
        } as never)
      }
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          response: new Response(),
          data: {
            items: [
              {
                id: 'grp-1',
                name: 'Front Office',
                parent_id: null,
                policy_id: null,
                effective_policy_id: 'pol-1',
                children: [],
              },
            ],
            next_cursor: '',
          },
        } as never)
      }
      return Promise.reject(new Error(`Unhandled GET ${path}`))
    })

    renderEditorWithRouter({ ids: ['office_123'] })
    const chip = await screen.findByText('office_123')
    expect(get).not.toHaveBeenCalled()

    fireEvent.mouseEnter(chip)
    expect(await screen.findByText('Reception Desk')).toBeInTheDocument()
    expect(screen.getByText('alex')).toBeInTheDocument()
    expect(screen.getByText('Pending')).toBeInTheDocument()
    expect(await screen.findByText('Front Office')).toBeInTheDocument()
    expect(screen.queryByText('Other Desk')).not.toBeInTheDocument()
    expect(get).toHaveBeenCalledWith(
      '/admin/api/v1/devices',
      expect.objectContaining({
        params: { query: { q: 'office_123', limit: 50 } },
      }),
    )

    fireEvent.mouseLeave(screen.getByText('office_123'))
    await waitFor(() => expect(screen.queryByText('Reception Desk')).not.toBeInTheDocument())
  })

  it('omits user row when username is empty and shows loading and error states', async () => {
    let resolveDevices!: (val: unknown) => void
    const get = vi
      .spyOn(api, 'GET')
      .mockImplementationOnce(() => new Promise((res) => (resolveDevices = res)) as never)
      .mockRejectedValueOnce(new Error('network down'))

    renderEditorWithRouter({ ids: ['NoUser_1', 'Err_Dev_1'] })
    const noUserChip = await screen.findByText('NoUser_1')
    fireEvent.mouseEnter(noUserChip)

    expect(await screen.findByLabelText('Loading device')).toBeInTheDocument()
    resolveDevices({
      response: new Response(),
      data: {
        items: [
          makeDevice({
            id: 'dev-nouser',
            rustdesk_id: 'NoUser_1',
            alias: '',
            hostname: 'lab-pc',
            username: '',
          }),
        ],
        next_cursor: '',
      },
    })
    expect(await screen.findByText('lab-pc')).toBeInTheDocument()
    expect(screen.queryByText(/User:/)).not.toBeInTheDocument()

    const errChip = screen.getByText('Err_Dev_1')
    fireEvent.focus(errChip)
    expect(await screen.findByText('Could not load this device.')).toBeInTheDocument()
    expect(get).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(errChip, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByText('Could not load this device.')).not.toBeInTheDocument(),
    )
  })

  it('shows not-found message and keeps not-found chip as plain text (not a link)', async () => {
    vi.spyOn(api, 'GET').mockResolvedValue({
      response: new Response(),
      data: { items: [], next_cursor: '' },
    } as never)

    const { router } = renderEditorWithRouter({ readOnly: true, ids: ['Missing_1'] })
    const chip = await screen.findByText('Missing_1')
    fireEvent.focus(chip)
    expect(await screen.findByText('No enrolled device with this ID.')).toBeInTheDocument()
    expect(chip.closest('a')).toBeNull()

    fireEvent.click(chip)
    expect(router.state.location.search).toEqual({})

    fireEvent.blur(chip)
    await waitFor(() =>
      expect(screen.queryByText('No enrolled device with this ID.')).not.toBeInTheDocument(),
    )
  })

  it('opens ?device=<uuid> on click when found (with from when inside a panel) and removes without navigating on ×', async () => {
    const devA = makeDevice({ id: 'dev-target', rustdesk_id: 'Office_123', alias: 'Office PC' })
    vi.spyOn(api, 'GET').mockResolvedValue({
      response: new Response(),
      data: { items: [devA], next_cursor: '' },
    } as never)

    const { router } = renderEditorWithRouter({
      ids: ['Office_123', 'Second_2'],
      fromDeviceId: 'dev-origin',
    })
    const chip = await screen.findByText('Office_123')
    fireEvent.mouseEnter(chip)
    expect(await screen.findByText('Office PC')).toBeInTheDocument()

    const link = screen.getByRole('link', { name: 'Office_123' })
    fireEvent.click(link)
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ device: 'dev-target', from: 'dev-origin' }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove Second_2' }))
    expect(screen.queryByText('Second_2')).not.toBeInTheDocument()
    expect(router.state.location.search).toEqual({ device: 'dev-target', from: 'dev-origin' })
  })
})
