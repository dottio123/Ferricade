import * as React from 'react'
import { act, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTickerListenerCount } from '@/lib/ticker'
import { SessionsTable, type RemoteSession } from './sessions-table'
import { TooltipProvider } from '@/components/ui/tooltip'

// Rows ask for the role (the Disconnect control); this test is about the ticker.
vi.mock('@/auth/role', () => ({ useRole: () => 'owner' }))

const renderDeviceLink = vi.fn()
vi.mock('@/components/devices/device-link', () => ({
  DeviceLink: ({ children }: { children: React.ReactNode }) => {
    renderDeviceLink()
    return <span>{children}</span>
  },
}))

const ended = {
  id: 'session-1',
  device_id: 'device-1',
  device_name: 'Workstation',
  started_at: '2026-10-11T12:00:00Z',
  ended_at: '2026-10-11T12:05:00Z',
  authed_at: '2026-10-11T12:00:01Z',
  duration_seconds: 300,
  type: 'remote',
  peer_name: 'Peer',
  peer_rustdesk_id: '123',
  rustdesk_id: '456',
  client_ip: '192.0.2.1',
  end_reason: null,
} as RemoteSession

afterEach(() => {
  vi.useRealTimers()
  renderDeviceLink.mockClear()
})

describe('sessions table ticker', () => {
  it('uses the shared clock without redrawing an ended row each second', () => {
    vi.useFakeTimers()
    const view = render(
      <TooltipProvider>
        <SessionsTable sessions={[ended]} />
      </TooltipProvider>,
    )
    const renders = renderDeviceLink.mock.calls.length
    expect(getTickerListenerCount()).toBe(1)
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(renderDeviceLink).toHaveBeenCalledTimes(renders)
    view.unmount()
    expect(getTickerListenerCount()).toBe(0)
  })

  it('adapts to phone card layout below sm while preserving desktop table structure', () => {
    const view = render(
      <TooltipProvider>
        <SessionsTable sessions={[ended]} />
      </TooltipProvider>,
    )

    const wrapper = view.container.querySelector('[data-slot="sessions-table-wrapper"]')
    expect(wrapper).toBeTruthy()
    expect(wrapper?.className).toContain('overflow-hidden')
    expect(wrapper?.className).toContain('sm:overflow-x-auto')

    const table = view.container.querySelector('table')
    expect(table?.className).toContain('block')
    expect(table?.className).toContain('sm:table')

    const header = view.container.querySelector('thead')
    expect(header?.className).toContain('hidden')
    expect(header?.className).toContain('sm:table-header-group')

    const row = view.container.querySelector('[data-slot="session-row"]')
    expect(row).toBeTruthy()
    expect(row?.className).toContain('grid')
    expect(row?.className).toContain('sm:table-row')

    // Verifies all required elements for mobile card view are present in the row
    const rowScope = within(row as HTMLElement)
    expect(rowScope.getByText('Workstation')).toBeTruthy()
    expect(rowScope.getByText('456')).toBeTruthy()
    expect(rowScope.getByText('Peer')).toBeTruthy()
    expect(rowScope.getByText('Closed')).toBeTruthy()
    expect(rowScope.getByText('5m')).toBeTruthy()

    view.unmount()
  })
})
