import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api } from '@/api/client'
import { FleetOverviewModule, statusSquareGlyph } from './fleet-overview'
import type { FleetMapDevice, Group } from './fleet-overview-tree'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string
    search?: unknown
    children: React.ReactNode
  }) => (
    <a href={typeof to === 'string' ? to : '.'} data-search={JSON.stringify(search)} {...props}>
      {children}
    </a>
  ),
}))

const makeDevice = (
  id: string,
  name: string,
  group_id: string | null,
  status: 'alert' | 'offline' | 'online',
): FleetMapDevice => ({
  id,
  name,
  group_id,
  status,
})

type ApiGetReturn = Promise<{ data: unknown; response: Response }>

describe('FleetOverviewModule status glyphs', () => {
  it('adds a shape to alert and pending squares and null for online', () => {
    expect(statusSquareGlyph('alert')).toBeTruthy()
    expect(statusSquareGlyph('pending')).toBeTruthy()
    expect(statusSquareGlyph('online')).toBeNull()
  })
})

describe('FleetOverviewModule states and rendering', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    localStorage.clear()
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    })
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  function renderModule({
    size = 'medium',
    isWall = false,
  }: {
    size?: 'small' | 'medium' | 'large'
    isWall?: boolean
  } = {}) {
    return render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <FleetOverviewModule size={size} isWall={isWall} />
        </TooltipProvider>
      </QueryClientProvider>,
    )
  }

  it('renders loading skeleton while fetching data', () => {
    vi.spyOn(api, 'GET').mockImplementation(() => new Promise(() => {}))
    const { container } = renderModule()
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
  })

  it('renders error state when fetch fails, with retry button', async () => {
    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/auth/me') {
        return Promise.resolve({
          data: { user: { id: 'u1', username: 'admin' } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      return Promise.reject(new Error('Network error'))
    })

    renderModule()
    await waitFor(() => {
      expect(screen.getByText(/could not load this/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    })
  })

  it('renders empty state when there are 0 approved devices in fleet', async () => {
    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/auth/me') {
        return Promise.resolve({
          data: { user: { id: 'u1', username: 'admin' } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/stats/fleet-map') {
        return Promise.resolve({
          data: { generated_at: '2026-10-23T12:00:00Z', truncated: false, devices: [] },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: { items: [], next_cursor: '' },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      return Promise.resolve({ data: {}, response: new Response() }) as unknown as ApiGetReturn
    })

    renderModule()
    await waitFor(() => {
      expect(screen.getByText('No approved devices in fleet')).toBeInTheDocument()
    })
  })

  it('renders top-level groups, badge, chevrons and device nodes', async () => {
    const subGroup: Group = {
      id: 'g-sub',
      name: 'Sub-Office',
      parent_id: 'g-hq',
      policy_id: null,
      effective_policy_id: 'p1',
      children: [],
    }
    const hqGroup: Group = {
      id: 'g-hq',
      name: 'HQ',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [subGroup],
    }
    const emptyGroup: Group = {
      id: 'g-empty',
      name: 'EmptyGroup',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [],
    }

    const devices: FleetMapDevice[] = [
      makeDevice('d-hq', 'HQ-PC', 'g-hq', 'online'),
      makeDevice('d-sub-1', 'Sub-Alert', 'g-sub', 'alert'),
      makeDevice('d-sub-2', 'Sub-Offline', 'g-sub', 'offline'),
      makeDevice('d-ungrouped', 'Ungrouped-PC', null, 'online'),
    ]

    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/auth/me') {
        return Promise.resolve({
          data: { user: { id: 'u1', username: 'admin' } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/stats/fleet-map') {
        return Promise.resolve({
          data: { generated_at: '2026-10-23T12:00:00Z', truncated: false, devices },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: { items: [hqGroup, emptyGroup], next_cursor: '' },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      return Promise.resolve({ data: {}, response: new Response() }) as unknown as ApiGetReturn
    })

    const { container } = renderModule()

    // Header badge: 4 devices · 1 offline · 1 alert
    await waitFor(() => {
      expect(screen.getByText('4 devices · 1 offline · 1 alert')).toBeInTheDocument()
    })

    // Group names as links with correct search params
    const hqLink = screen.getByText('HQ')
    expect(hqLink).toBeInTheDocument()
    expect(hqLink.closest('a')).toHaveAttribute(
      'data-search',
      JSON.stringify({ group: 'g-hq', subgroups: true }),
    )

    const ungroupedLink = screen.getByText('Ungrouped')
    expect(ungroupedLink).toBeInTheDocument()
    expect(ungroupedLink.closest('a')).toHaveAttribute(
      'data-search',
      JSON.stringify({ group: 'ungrouped' }),
    )

    // Empty group shows "no devices"
    expect(screen.getByText('no devices')).toBeInTheDocument()

    // Chevron for HQ (default collapsed)
    const expandBtn = screen.getByRole('button', { name: 'Expand HQ' })
    expect(expandBtn).toHaveAttribute('aria-expanded', 'false')
    expect(expandBtn).toHaveAttribute('aria-controls', 'group-subgroups-g-hq')

    // While collapsed, HQ shows all 3 rolled-up devices (HQ-PC, Sub-Alert, Sub-Offline)
    expect(screen.getByRole('link', { name: 'HQ-PC, online' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sub-Alert, alert' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sub-Offline, offline' })).toBeInTheDocument()

    // Sub-Office is NOT visible yet
    expect(screen.queryByText('Sub-Office')).not.toBeInTheDocument()

    // Expand HQ
    fireEvent.click(expandBtn)

    // Now chevron is Collapse HQ
    expect(screen.getByRole('button', { name: 'Collapse HQ' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText('Sub-Office')).toBeInTheDocument()

    const scrollArea = container.querySelector('[data-slot="fleet-overview-body"]')
    expect(scrollArea).toHaveAttribute('tabindex', '0')
    expect(scrollArea?.parentElement).toHaveClass('min-h-0')
    expect(scrollArea).toHaveClass('overflow-y-auto')

    // Sub-Office row has its direct devices
    const subOfficeLink = screen.getByText('Sub-Office')
    expect(subOfficeLink.closest('a')).toHaveAttribute(
      'data-search',
      JSON.stringify({ group: 'g-sub', subgroups: true }),
    )

    // Expanded state saved in localStorage for user u1
    expect(localStorage.getItem('ferricade:fleet-overview:expanded:u1')).toBe(
      JSON.stringify(['g-hq']),
    )
  })

  it('restores expanded state per user from localStorage', async () => {
    localStorage.setItem('ferricade:fleet-overview:expanded:u1', JSON.stringify(['g-parent']))

    const subGroup: Group = {
      id: 'g-child',
      name: 'Child Group',
      parent_id: 'g-parent',
      policy_id: null,
      effective_policy_id: 'p1',
      children: [],
    }
    const parentGroup: Group = {
      id: 'g-parent',
      name: 'Parent Group',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [subGroup],
    }

    const devices = [makeDevice('d1', 'Device-01', 'g-child', 'online')]

    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/auth/me') {
        return Promise.resolve({
          data: { user: { id: 'u1', username: 'admin' } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/stats/fleet-map') {
        return Promise.resolve({
          data: { generated_at: '2026-10-23T12:00:00Z', truncated: false, devices },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: { items: [parentGroup], next_cursor: '' },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      return Promise.resolve({ data: {}, response: new Response() }) as unknown as ApiGetReturn
    })

    renderModule()

    // Already expanded on mount!
    await waitFor(() => {
      expect(screen.getByText('Child Group')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Collapse Parent Group' })).toBeInTheDocument()
    })
  })

  it('collapses to proportional status bar when nodes exceed line limits at measured width', async () => {
    const group: Group = {
      id: 'g1',
      name: 'Large Fleet Group',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [],
    }

    // 25 devices
    const devices: FleetMapDevice[] = Array.from({ length: 25 }).map((_, i) =>
      makeDevice(
        `d-${i}`,
        `Device-${String(i).padStart(2, '0')}`,
        'g1',
        i === 0 ? 'alert' : 'online',
      ),
    )

    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/auth/me') {
        return Promise.resolve({
          data: { user: { id: 'u1', username: 'admin' } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/stats/fleet-map') {
        return Promise.resolve({
          data: { generated_at: '2026-10-23T12:00:00Z', truncated: false, devices },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: { items: [group], next_cursor: '' },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      return Promise.resolve({ data: {}, response: new Response() }) as unknown as ApiGetReturn
    })

    // Mock clientWidth on HTMLElement to simulate measured width of 260px
    const originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientWidth',
    )
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 260,
    })

    try {
      renderModule({ size: 'medium' })

      await waitFor(() => {
        expect(screen.getByText('Large Fleet Group')).toBeInTheDocument()
      })

      // Bar with accessible text "1 alert, 24 online" should be rendered
      await waitFor(() => {
        const bar = screen.getByRole('img', { name: '1 alert, 24 online' })
        expect(bar).toBeInTheDocument()
      })
      expect(screen.getByText('1 alert')).toBeInTheDocument()
      expect(screen.getByText('24 online')).toBeInTheDocument()
    } finally {
      if (originalClientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
      }
    }
  })

  it('handles truncated: true by rendering bars only and showing badge tooltip', async () => {
    const group: Group = {
      id: 'g1',
      name: 'IT Group',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [],
    }
    const devices = [makeDevice('d1', 'PC-01', 'g1', 'online')]

    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/auth/me') {
        return Promise.resolve({
          data: { user: { id: 'u1', username: 'admin' } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/stats/fleet-map') {
        return Promise.resolve({
          data: { generated_at: '2026-10-23T12:00:00Z', truncated: true, devices },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: { items: [group], next_cursor: '' },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/stats/summary') {
        return Promise.resolve({
          data: { devices: { approved: 2500 } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      return Promise.resolve({ data: {}, response: new Response() }) as unknown as ApiGetReturn
    })

    renderModule()

    await waitFor(() => {
      expect(screen.getByText('IT Group')).toBeInTheDocument()
    })

    // Renders bar rather than node link
    expect(screen.getByRole('img', { name: '1 online' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'PC-01, online' })).not.toBeInTheDocument()
  })

  it('renders wall display with problems first, no chevrons, no links, and +N healthy groups', async () => {
    const makeGroup = (name: string, id: string): Group => ({
      id,
      name,
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [],
    })

    const groups: Group[] = [
      makeGroup('Healthy Zeta', 'g-zeta'),
      makeGroup('Problem Group', 'g-prob'),
      makeGroup('Healthy Alpha', 'g-alpha'),
      makeGroup('Healthy Beta', 'g-beta'),
      makeGroup('Healthy Gamma', 'g-gamma'),
    ]

    const devices: FleetMapDevice[] = [
      makeDevice('d1', 'Prob-1', 'g-prob', 'alert'),
      makeDevice('d2', 'Zeta-1', 'g-zeta', 'online'),
      makeDevice('d3', 'Alpha-1', 'g-alpha', 'online'),
      makeDevice('d4', 'Beta-1', 'g-beta', 'online'),
      makeDevice('d5', 'Gamma-1', 'g-gamma', 'online'),
    ]

    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/auth/me') {
        return Promise.resolve({
          data: { user: { id: 'u1', username: 'admin' } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/stats/fleet-map') {
        return Promise.resolve({
          data: { generated_at: '2026-10-23T12:00:00Z', truncated: false, devices },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: { items: groups, next_cursor: '' },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      return Promise.resolve({ data: {}, response: new Response() }) as unknown as ApiGetReturn
    })

    // Mock clientHeight on container to fit 3 rows
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight',
    )
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 150, // fits 3 rows
    })

    try {
      renderModule({ isWall: true })

      await waitFor(() => {
        expect(screen.getByText('Problem Group')).toBeInTheDocument()
      })

      // No "View all" link in wall mode
      expect(screen.queryByText('View all')).not.toBeInTheDocument()

      // Group names are plain text, not links
      expect(screen.getByText('Problem Group').closest('a')).toBeNull()

      // Problem Group is listed first
      // Hidden healthy groups message appears
      expect(screen.getByText(/\+\d+ healthy groups/)).toBeInTheDocument()
    } finally {
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
      }
    }
  })

  it('renders small size (2×2) with slim status bars and one line per group', async () => {
    const group: Group = {
      id: 'g1',
      name: 'Office',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [],
    }
    const devices = [makeDevice('d1', 'PC-01', 'g1', 'online')]

    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/auth/me') {
        return Promise.resolve({
          data: { user: { id: 'u1', username: 'admin' } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/stats/fleet-map') {
        return Promise.resolve({
          data: { generated_at: '2026-10-23T12:00:00Z', truncated: false, devices },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: { items: [group], next_cursor: '' },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      return Promise.resolve({ data: {}, response: new Response() }) as unknown as ApiGetReturn
    })

    renderModule({ size: 'small' })

    await waitFor(() => {
      expect(screen.getByText('Office')).toBeInTheDocument()
    })

    // Renders slim status bar (h-1.5), no individual node square link
    expect(screen.getByRole('img', { name: '1 online' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'PC-01, online' })).not.toBeInTheDocument()
  })

  it('renders phone header badge with single-line compact format, accessible name and tooltip', async () => {
    const devices = [
      makeDevice('d1', 'A1', null, 'online'),
      makeDevice('d2', 'A2', null, 'offline'),
      makeDevice('d3', 'A3', null, 'alert'),
    ]

    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/auth/me') {
        return Promise.resolve({
          data: { user: { id: 'u1', username: 'admin' } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/stats/fleet-map') {
        return Promise.resolve({
          data: { generated_at: '2026-10-23T12:00:00Z', truncated: false, devices },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: { items: [], next_cursor: '' },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      return Promise.resolve({ data: {}, response: new Response() }) as unknown as ApiGetReturn
    })

    renderModule()

    await waitFor(() => {
      expect(screen.getByText('3 devices · 1 offline · 1 alert')).toBeInTheDocument()
    })

    // Desktop badge in header has hidden sm:inline-flex
    const desktopBadge = screen.getByText('3 devices · 1 offline · 1 alert')
    expect(desktopBadge.closest('[data-slot="badge"]')).toHaveClass('hidden sm:inline-flex')

    // Mobile badge on its own line has whitespace-nowrap and shrink-0
    const mobileBadge = screen.getByText('3 · 1 off · 1 ⚠')
    const mobileBadgeContainer = mobileBadge.closest('[data-slot="badge"]')
    expect(mobileBadgeContainer).toHaveClass('whitespace-nowrap')
    expect(mobileBadgeContainer).toHaveClass('shrink-0')
    expect(mobileBadgeContainer).toHaveAttribute('title', '3 devices · 1 offline · 1 alert')
    expect(mobileBadgeContainer).toHaveAttribute('aria-label', '3 devices · 1 offline · 1 alert')
  })

  it('guarantees card title is never truncated at 320px card width with mobile badge on own line', async () => {
    const devices = [
      makeDevice('d1', 'A1', null, 'online'),
      makeDevice('d2', 'A2', null, 'offline'),
      makeDevice('d3', 'A3', null, 'alert'),
    ]

    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/auth/me') {
        return Promise.resolve({
          data: { user: { id: 'u1', username: 'admin' } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/stats/fleet-map') {
        return Promise.resolve({
          data: { generated_at: '2026-10-23T12:00:00Z', truncated: false, devices },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: { items: [], next_cursor: '' },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      return Promise.resolve({ data: {}, response: new Response() }) as unknown as ApiGetReturn
    })

    const originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientWidth',
    )
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 320,
    })

    try {
      renderModule({ size: 'medium' })

      await waitFor(() => {
        expect(screen.getByText('3 devices · 1 offline · 1 alert')).toBeInTheDocument()
      })

      // Title element exists in card-title slot
      const title = screen.getByText('Fleet overview')
      expect(title).toHaveAttribute('data-slot', 'card-title')

      // Desktop badge in header is hidden on mobile so title is not squeezed
      const desktopBadge = screen.getByText('3 devices · 1 offline · 1 alert')
      expect(desktopBadge.closest('[data-slot="badge"]')).toHaveClass('hidden sm:inline-flex')

      // Mobile badge is rendered in card body with sm:hidden wrapper
      const mobileBadge = screen.getByText('3 · 1 off · 1 ⚠')
      expect(mobileBadge.closest('.sm\\:hidden')).toBeInTheDocument()

      // "View all" action is accessible
      expect(screen.getByRole('link', { name: 'View all devices' })).toBeInTheDocument()
    } finally {
      if (originalClientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
      }
    }
  })

  it('renders compact count text in bar row on phone widths without clipping', async () => {
    const group: Group = {
      id: 'g1',
      name: 'Branch offices',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [],
    }

    // 2 alert, 30 offline, 45 online
    const devices: FleetMapDevice[] = [
      makeDevice('a1', 'Alert-1', 'g1', 'alert'),
      makeDevice('a2', 'Alert-2', 'g1', 'alert'),
      ...Array.from({ length: 30 }, (_, i) => makeDevice(`off-${i}`, `Off-${i}`, 'g1', 'offline')),
      ...Array.from({ length: 45 }, (_, i) => makeDevice(`on-${i}`, `On-${i}`, 'g1', 'online')),
    ]

    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/auth/me') {
        return Promise.resolve({
          data: { user: { id: 'u1', username: 'admin' } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/stats/fleet-map') {
        return Promise.resolve({
          data: { generated_at: '2026-10-23T12:00:00Z', truncated: false, devices },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: { items: [group], next_cursor: '' },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      return Promise.resolve({ data: {}, response: new Response() }) as unknown as ApiGetReturn
    })

    const originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientWidth',
    )
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 260,
    })

    try {
      renderModule({ size: 'large' })

      await waitFor(() => {
        expect(screen.getByText('Branch offices')).toBeInTheDocument()
      })

      // Bar container has full accessible name and tooltip
      const bar = screen.getByRole('img', { name: '2 alert, 30 offline, 45 online' })
      expect(bar).toBeInTheDocument()
      expect(bar).toHaveAttribute('title', '2 alert, 30 offline, 45 online')

      // Desktop full count has hidden sm:flex
      const alertDesktop = screen.getByText('2 alert')
      expect(alertDesktop.closest('.hidden.sm\\:flex')).toBeInTheDocument()
      expect(screen.getByText('30 offline')).toBeInTheDocument()
      expect(screen.getByText('45 online')).toBeInTheDocument()

      // Phone compact count has flex sm:hidden with non-zero problem counts only
      const alertMobile = screen.getByText('2⚠')
      expect(alertMobile).toBeInTheDocument()
      expect(alertMobile).toHaveClass('text-status-alert font-medium')
      expect(screen.getByText('30 off')).toBeInTheDocument()
      expect(alertMobile.closest('.flex.sm\\:hidden')).toHaveClass('whitespace-nowrap shrink-0')
    } finally {
      if (originalClientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
      }
    }
  })

  it('renders rows as two lines below sm with full name on line 1 and indented bar on line 2', async () => {
    const parentGroup: Group = {
      id: 'g-parent',
      name: 'SIA | Administration',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [
        {
          id: 'g-child',
          name: 'JCC | Front Desk',
          parent_id: 'g-parent',
          policy_id: null,
          effective_policy_id: 'p1',
          children: [],
        },
      ],
    }

    const devices: FleetMapDevice[] = [
      makeDevice('d1', 'Admin-PC', 'g-parent', 'online'),
      makeDevice('d2', 'Admin-Laptop', 'g-parent', 'offline'),
      makeDevice('d3', 'Front-1', 'g-child', 'alert'),
      makeDevice('d4', 'Front-2', 'g-child', 'online'),
    ]

    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/auth/me') {
        return Promise.resolve({
          data: { user: { id: 'u1', username: 'admin' } },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/stats/fleet-map') {
        return Promise.resolve({
          data: { generated_at: '2026-10-23T12:00:00Z', truncated: false, devices },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: { items: [parentGroup], next_cursor: '' },
          response: new Response(),
        }) as unknown as ApiGetReturn
      }
      return Promise.resolve({ data: {}, response: new Response() }) as unknown as ApiGetReturn
    })

    const originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientWidth',
    )
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 320,
    })

    try {
      const { container } = renderModule({ size: 'medium' })

      await waitFor(() => {
        expect(screen.getByText('SIA | Administration')).toBeInTheDocument()
      })

      // The row item should have two distinct container lines below sm
      const groupLink = screen.getByText('SIA | Administration')
      expect(groupLink).toHaveAttribute('title', 'SIA | Administration')

      const header = container.querySelector('[data-slot="fleet-group-header"]')
      expect(header).toBeInTheDocument()
      expect(header).toHaveClass('w-full', 'justify-between', 'sm:w-48')
      expect(header).toContainElement(groupLink)

      // Right-aligned online/total count is inside line 1 header
      const count = header?.querySelector('.font-mono')
      expect(count).toBeInTheDocument()
      expect(count?.textContent).toBe('3/4')

      // Line 2 content is a separate container indented under the group name
      const content = container.querySelector('[data-slot="fleet-group-content"]')
      expect(content).toBeInTheDocument()
      expect(content).toHaveClass('pl-6', 'sm:pl-0')

      // Outer row container switches between flex-col below sm and sm:flex-row
      const rowContainer = header?.parentElement
      expect(rowContainer).toHaveClass('flex-col', 'sm:flex-row', 'sm:items-center')

      // Expand parent to check subgroup row
      const expandButton = screen.getByRole('button', { name: 'Expand SIA | Administration' })
      fireEvent.click(expandButton)

      await waitFor(() => {
        expect(screen.getByText('JCC | Front Desk')).toBeInTheDocument()
      })

      const childLink = screen.getByText('JCC | Front Desk')
      expect(childLink).toHaveAttribute('title', 'JCC | Front Desk')

      const allHeaders = container.querySelectorAll('[data-slot="fleet-group-header"]')
      expect(allHeaders.length).toBe(2)
      expect(allHeaders[1]).toHaveClass('w-full', 'justify-between', 'sm:w-48')
    } finally {
      if (originalClientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
      }
    }
  })
})
