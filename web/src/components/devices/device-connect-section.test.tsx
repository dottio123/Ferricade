import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '@/api/schema'
import { DeviceConnectSection, useDeviceConnect } from './device-connect-section'

const get = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({
  api: { GET: get },
  unwrap: async (p: Promise<{ data?: unknown; error?: unknown }>) => {
    const r = await p
    if (r.error) throw r.error
    return r.data
  },
}))

const assign = vi.fn()

beforeEach(() => {
  get.mockReset()
  get.mockImplementation(
    async (_path: string, init: { params: { query: { action: string; relay: string } } }) => ({
      data: {
        url: `rustdesk://${init.params.query.action}/123456789${init.params.query.relay === '1' ? '/r' : ''}`,
        command: 'rustdesk --connect 123456789',
        includes_server: false,
      },
    }),
  )
  assign.mockReset()
  vi.stubGlobal('location', { ...window.location, assign })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Harness({
  locked = false,
  deviceId = 'dev-1',
  noPolicy = false,
}: {
  locked?: boolean
  deviceId?: string
  noPolicy?: boolean
}) {
  const connection = useDeviceConnect(deviceId)
  return (
    <DeviceConnectSection
      connection={connection}
      policyStatus={
        noPolicy
          ? undefined
          : ({
              connect: locked ? 'locked' : 'unrestricted',
            } as components['schemas']['DevicePolicyStatus'])
      }
    />
  )
}

function renderHarness(props: { locked?: boolean; deviceId?: string; noPolicy?: boolean } = {}) {
  const client = new QueryClient()
  const ui = (p: typeof props) => (
    <QueryClientProvider client={client}>
      <Harness {...p} />
    </QueryClientProvider>
  )
  const view = render(ui(props))
  return { ...view, rerenderWith: (p: typeof props) => view.rerender(ui(p)) }
}

const click = async (el: Element) => {
  fireEvent.click(el)
}

const summary = () => document.querySelector('summary') as HTMLElement

const box = () =>
  document.querySelector('details[data-slot="connect-link-box"]') as HTMLDetailsElement

describe('Device connect link box', () => {
  it('is present, closed and makes no request until opened', () => {
    renderHarness()
    expect(box()).not.toBeNull()
    expect(box().open).toBe(false)
    expect(summary()).toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
  })

  it('fetches once on open without launching RustDesk', async () => {
    renderHarness()
    await click(summary())
    expect(await screen.findByRole('link', { name: /Open in RustDesk/ })).toHaveAttribute(
      'href',
      'rustdesk://connect/123456789',
    )
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0]![1].params.query).toEqual({ action: 'connect', relay: '0' })
    expect(assign).not.toHaveBeenCalled()
  })

  it('refetches once when the relay changes while open', async () => {
    renderHarness()
    await click(summary())
    await screen.findByRole('link', { name: /Open in RustDesk/ })
    await click(screen.getByLabelText('Force relay'))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    expect(get.mock.calls[1]![1].params.query).toEqual({ action: 'connect', relay: '1' })
    expect(await screen.findByRole('link', { name: /Open in RustDesk/ })).toHaveAttribute(
      'href',
      'rustdesk://connect/123456789/r',
    )
    expect(assign).not.toHaveBeenCalled()
  })

  it('shows the setup requirement only for plain links', async () => {
    renderHarness()
    await click(summary())
    expect(
      await screen.findByText(
        'Works only from a RustDesk client already set to this server and its key.',
      ),
    ).toBeInTheDocument()
  })

  it('shows a fetch error inside the box', async () => {
    get.mockResolvedValueOnce({ error: { error: { code: 'boom', message: 'No link today' } } })
    renderHarness()
    await click(summary())
    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument()
    expect(box().contains(screen.getByText(/Something went wrong/))).toBe(true)
  })

  it('Connect while closed launches, fills the box and leaves it closed', async () => {
    renderHarness()
    await click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('rustdesk://connect/123456789'))
    expect(box().open).toBe(false)
    await click(summary())
    expect(await screen.findByRole('link', { name: /Open in RustDesk/ })).toBeInTheDocument()
  })

  it('does not open or fetch when locked by policy', async () => {
    renderHarness({ locked: true })
    expect(summary().closest('summary')).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(summary())
    expect(box().open).toBe(false)
    expect(get).not.toHaveBeenCalled()
  })

  it('collapses when the panel switches device', async () => {
    const { rerenderWith } = renderHarness()
    await click(summary())
    await screen.findByRole('link', { name: /Open in RustDesk/ })
    rerenderWith({ deviceId: 'dev-2' })
    expect(box().open).toBe(false)
    expect(screen.queryByRole('link', { name: /Open in RustDesk/ })).not.toBeInTheDocument()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('does not open or fetch while the policy is still unknown, then works once it arrives', async () => {
    const { rerenderWith } = renderHarness({ noPolicy: true })
    expect(summary()).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(summary())
    expect(box().open).toBe(false)
    expect(get).not.toHaveBeenCalled()
    rerenderWith({})
    fireEvent.click(summary())
    expect(await screen.findByRole('link', { name: /Open in RustDesk/ })).toBeInTheDocument()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('a slow Connect response does not overwrite a newer preview, but still launches', async () => {
    let finishConnect: (v: unknown) => void = () => {}
    get.mockImplementationOnce(() => new Promise((resolve) => (finishConnect = resolve)))
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await click(summary())
    // Changing the relay stands in for picking another action: both refetch the preview.
    fireEvent.click(screen.getByLabelText('Force relay'))
    expect(await screen.findByRole('link', { name: /Open in RustDesk/ })).toHaveAttribute(
      'href',
      'rustdesk://connect/123456789/r',
    )
    finishConnect({
      data: { url: 'rustdesk://connect/123456789', command: 'old', includes_server: false },
    })
    await waitFor(() => expect(assign).toHaveBeenCalledWith('rustdesk://connect/123456789'))
    expect(screen.getByRole('link', { name: /Open in RustDesk/ })).toHaveAttribute(
      'href',
      'rustdesk://connect/123456789/r',
    )
  })
})
