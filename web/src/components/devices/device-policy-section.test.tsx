import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { components } from '@/api/schema'
import { DevicePolicySection } from './device-policy-section'
import { api } from '@/api/client'
import { ApiError } from '@/api/errors'

type DevicePolicyStatus = components['schemas']['DevicePolicyStatus']

vi.mock('@/auth/role', () => ({
  useRole: vi.fn(() => 'owner'),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string
    search?: Record<string, unknown>
    children: React.ReactNode
  }) => {
    const q = search ? '?' + new URLSearchParams(search as Record<string, string>).toString() : ''
    return (
      <a href={`${to}${q}`} {...props}>
        {children}
      </a>
    )
  },
}))

import { useRole } from '@/auth/role'

function makeStatus(overrides: Partial<DevicePolicyStatus> = {}): DevicePolicyStatus {
  return {
    push_enabled: true,
    policy: { id: 'p-1', name: 'Default' },
    source: 'default',
    source_group: null,
    effective_settings: {},
    status: 'applied',
    connect: 'attended',
    always_reachable: false,
    window: null,
    close_unconfirmed_since: null,
    ...overrides,
  }
}

function renderSection(status: DevicePolicyStatus, role = 'owner', deviceId = 'dev-1') {
  vi.mocked(useRole).mockReturnValue(role as 'owner' | 'admin' | 'user')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  vi.spyOn(api, 'GET').mockImplementation((path: string) => {
    if (path === '/admin/api/v1/devices/{id}/policy') {
      return Promise.resolve({
        response: new Response(),
        data: status,
      } as never)
    }
    return Promise.reject(new Error(`Unhandled GET ${path}`))
  })

  const view = render(
    <QueryClientProvider client={client}>
      <DevicePolicySection deviceId={deviceId} />
    </QueryClientProvider>,
  )

  return { ...view, client }
}

describe('DevicePolicySection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  describe('Status line', () => {
    it('renders for source group, parent_group, and default', async () => {
      // 1. group source
      renderSection(
        makeStatus({
          source: 'group',
          source_group: { id: 'g-1', name: 'Workstations' },
          policy: { id: 'p-1', name: 'Strict' },
          status: 'applied',
        }),
      )
      await waitFor(() => {
        expect(
          screen.getByText((content) =>
            content.includes('Policy: Strict (from group Workstations) · Applied'),
          ),
        ).toBeInTheDocument()
      })
      cleanup()

      // 2. parent_group source
      renderSection(
        makeStatus({
          source: 'parent_group',
          source_group: { id: 'g-parent', name: 'Headquarters' },
          policy: { id: 'p-2', name: 'Standard' },
          status: 'pending',
        }),
      )
      await waitFor(() => {
        expect(
          screen.getByText((content) =>
            content.includes('Policy: Standard (from group Headquarters) · Pending'),
          ),
        ).toBeInTheDocument()
      })
      cleanup()

      // 3. default source
      renderSection(
        makeStatus({
          source: 'default',
          source_group: null,
          policy: { id: 'p-0', name: 'Default' },
          status: 'applied',
        }),
      )
      await waitFor(() => {
        expect(
          screen.getByText((content) => content.includes('Policy: Default · Applied')),
        ).toBeInTheDocument()
      })
      cleanup()

      // 4. off status
      renderSection(
        makeStatus({
          source: 'default',
          source_group: null,
          policy: { id: 'p-0', name: 'Default' },
          status: 'off',
        }),
      )
      await waitFor(() => {
        const text = screen.getByText((content) => content.includes('Policy: Default · Off'))
        expect(text).toBeInTheDocument()
        expect(text.textContent).toContain('Policy push is off.')
      })
    })
  })

  describe('Always reachable', () => {
    it('shows always reachable line and hides window controls', async () => {
      renderSection(
        makeStatus({
          always_reachable: true,
          status: 'applied',
        }),
      )
      await waitFor(() => {
        expect(
          screen.getByText('Always reachable (policy allows password logins)'),
        ).toBeInTheDocument()
      })
      expect(screen.queryByRole('button', { name: /Allow access/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /Close now/i })).toBeNull()
    })

    it('shows explanation with link to /policies?edit=<policy.id> for owner and admin', async () => {
      renderSection(
        makeStatus({
          always_reachable: true,
          policy: { id: 'pol-123', name: 'Workstations' },
          status: 'applied',
        }),
        'owner',
      )
      await waitFor(() => {
        expect(
          screen.getByText('Always reachable (policy allows password logins)'),
        ).toBeInTheDocument()
      })
      const link = screen.getByRole('link', { name: "Change the policy's baseline" })
      expect(link).toHaveAttribute('href', '/policies?edit=pol-123')
      expect(link).toHaveClass('underline', 'underline-offset-4')
      expect(link.className).not.toBe('text-primary hover:underline underline-offset-4')
      expect(
        screen.getByText(
          (_, element) =>
            element?.textContent ===
            "Timed access is available when this device's policy refuses password logins. Change the policy's baseline to use it.",
        ),
      ).toBeInTheDocument()
    })

    it('hides explanation for user role', async () => {
      renderSection(
        makeStatus({
          always_reachable: true,
          policy: { id: 'pol-123', name: 'Workstations' },
          status: 'applied',
        }),
        'user',
      )
      await waitFor(() => {
        expect(
          screen.getByText('Always reachable (policy allows password logins)'),
        ).toBeInTheDocument()
      })
      expect(screen.queryByRole('link', { name: "Change the policy's baseline" })).toBeNull()
      expect(
        screen.queryByText(
          /Timed access is available when this device's policy refuses password logins/,
        ),
      ).toBeNull()
    })
  })

  describe('Allow access controls', () => {
    it('hides Allow access control when policy push is off', async () => {
      renderSection(
        makeStatus({
          always_reachable: false,
          push_enabled: false,
          status: 'off',
          window: null,
        }),
      )
      await waitFor(() => {
        expect(
          screen.getByText((content) => content.includes('Policy push is off.')),
        ).toBeInTheDocument()
      })
      expect(screen.queryByRole('button', { name: /Allow access/i })).toBeNull()
    })

    it('sends each duration and checkbox state when opening a window', async () => {
      const postSpy = vi.spyOn(api, 'POST').mockImplementation((path: string) => {
        if (path === '/admin/api/v1/devices/{id}/access-window') {
          return Promise.resolve({
            response: new Response(),
            data: {
              id: 'win-1',
              opened_by: { id: 'u-1', display_name: 'Owner' },
              opened_at: new Date().toISOString(),
              ends_at: new Date(Date.now() + 3600000).toISOString(),
              disconnect_on_close: false,
            },
          } as never)
        }
        return Promise.reject(new Error(`Unhandled POST ${path}`))
      })

      renderSection(makeStatus({ always_reachable: false, window: null, status: 'applied' }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Allow access' })).toBeInTheDocument()
      })

      // Clicking 'Allow access' opens the controls
      fireEvent.click(screen.getByRole('button', { name: 'Allow access' }))
      expect(screen.getByRole('button', { name: 'Open window' })).toBeInTheDocument()

      // Default: 1 h (60 minutes), disconnect_on_close: false
      fireEvent.click(screen.getByRole('button', { name: 'Open window' }))
      await waitFor(() => {
        expect(postSpy).toHaveBeenCalledWith(
          '/admin/api/v1/devices/{id}/access-window',
          expect.objectContaining({
            params: { path: { id: 'dev-1' } },
            body: { duration_minutes: 60, disconnect_on_close: false },
          }),
        )
      })

      // Re-open controls for subsequent tests
      fireEvent.click(screen.getByRole('button', { name: 'Allow access' }))

      // Test checkbox toggle
      const checkbox = screen.getByLabelText('Also disconnect when it closes')
      fireEvent.click(checkbox)
      fireEvent.click(screen.getByRole('button', { name: 'Open window' }))
      await waitFor(() => {
        expect(postSpy).toHaveBeenLastCalledWith(
          '/admin/api/v1/devices/{id}/access-window',
          expect.objectContaining({
            body: { duration_minutes: 60, disconnect_on_close: true },
          }),
        )
      })

      // Re-open controls
      fireEvent.click(screen.getByRole('button', { name: 'Allow access' }))

      // Test other durations: 4 h
      const durationSelect = screen.getByLabelText('Duration')
      fireEvent.change(durationSelect, { target: { value: '240' } })
      fireEvent.click(screen.getByRole('button', { name: 'Open window' }))
      await waitFor(() => {
        expect(postSpy).toHaveBeenLastCalledWith(
          '/admin/api/v1/devices/{id}/access-window',
          expect.objectContaining({
            body: { duration_minutes: 240, disconnect_on_close: true },
          }),
        )
      })

      // Re-open controls
      fireEvent.click(screen.getByRole('button', { name: 'Allow access' }))

      // 8 h
      fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '480' } })
      fireEvent.click(screen.getByRole('button', { name: 'Open window' }))
      await waitFor(() => {
        expect(postSpy).toHaveBeenLastCalledWith(
          '/admin/api/v1/devices/{id}/access-window',
          expect.objectContaining({
            body: { duration_minutes: 480, disconnect_on_close: true },
          }),
        )
      })

      // Re-open controls
      fireEvent.click(screen.getByRole('button', { name: 'Allow access' }))

      // Until switched off (null)
      fireEvent.change(screen.getByLabelText('Duration'), { target: { value: 'null' } })
      fireEvent.click(screen.getByRole('button', { name: 'Open window' }))
      await waitFor(() => {
        expect(postSpy).toHaveBeenLastCalledWith(
          '/admin/api/v1/devices/{id}/access-window',
          expect.objectContaining({
            body: { duration_minutes: null, disconnect_on_close: true },
          }),
        )
      })
    })
  })

  describe('Open window', () => {
    it('shows both Reachable until forms and handles Close now with disconnect', async () => {
      // Form 1: timed window ending today
      const todayEnd = new Date()
      todayEnd.setHours(15, 30, 0, 0)
      const expectedTimeStr = todayEnd.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })

      renderSection(
        makeStatus({
          window: {
            id: 'w-1',
            opened_by: { id: 'u-1', display_name: 'Admin' },
            opened_at: new Date().toISOString(),
            ends_at: todayEnd.toISOString(),
            disconnect_on_close: false,
          },
        }),
      )

      await waitFor(() => {
        expect(
          screen.getByText(new RegExp(`Reachable until ${expectedTimeStr}`)),
        ).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: 'Close now' })).toBeInTheDocument()
      expect(screen.getByLabelText('Also disconnect')).toBeInTheDocument()
      cleanup()

      // Form 2: window until switched off (ends_at null)
      const postSpy = vi.spyOn(api, 'POST').mockImplementation((path: string) => {
        if (path === '/admin/api/v1/devices/{id}/access-window/close') {
          return Promise.resolve({ response: new Response(null, { status: 204 }) } as never)
        }
        return Promise.reject(new Error(`Unhandled POST ${path}`))
      })

      renderSection(
        makeStatus({
          window: {
            id: 'w-2',
            opened_by: { id: 'u-1', display_name: 'Admin' },
            opened_at: new Date().toISOString(),
            ends_at: null,
            disconnect_on_close: true,
          },
        }),
      )

      await waitFor(() => {
        expect(screen.getByText('Reachable until switched off')).toBeInTheDocument()
      })

      // Click Close now without checkbox
      fireEvent.click(screen.getByRole('button', { name: 'Close now' }))
      await waitFor(() => {
        expect(postSpy).toHaveBeenCalledWith(
          '/admin/api/v1/devices/{id}/access-window/close',
          expect.objectContaining({
            params: { path: { id: 'dev-1' } },
            body: { disconnect: false },
          }),
        )
      })

      // Click Close now with checkbox
      const alsoDisconnectCheckbox = screen.getByLabelText('Also disconnect')
      fireEvent.click(alsoDisconnectCheckbox)
      fireEvent.click(screen.getByRole('button', { name: 'Close now' }))
      await waitFor(() => {
        expect(postSpy).toHaveBeenLastCalledWith(
          '/admin/api/v1/devices/{id}/access-window/close',
          expect.objectContaining({
            params: { path: { id: 'dev-1' } },
            body: { disconnect: true },
          }),
        )
      })
    })
  })

  describe('Unconfirmed close warning', () => {
    it('shows warning with and without push off', async () => {
      const closedAt = new Date('2026-10-19T14:20:00Z')
      const timeStr = closedAt.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })

      // Push on (status applied)
      renderSection(
        makeStatus({
          status: 'applied',
          close_unconfirmed_since: closedAt.toISOString(),
        }),
      )
      await waitFor(() => {
        const warning = screen.getByText(
          new RegExp(`Closing… not confirmed by the device since ${timeStr}`),
        )
        expect(warning).toBeInTheDocument()
        expect(warning.textContent).toContain(
          'Until it confirms, it may still accept password logins.',
        )
        expect(warning.textContent).not.toContain(
          'Policy push is off, so the device cannot receive the closed settings.',
        )
      })
      cleanup()

      // Push off (status off)
      renderSection(
        makeStatus({
          status: 'off',
          push_enabled: false,
          close_unconfirmed_since: closedAt.toISOString(),
        }),
      )
      await waitFor(() => {
        const warning = screen.getByText(
          new RegExp(`Closing… not confirmed by the device since ${timeStr}`),
        )
        expect(warning).toBeInTheDocument()
        expect(warning.textContent).toContain(
          'Policy push is off, so the device cannot receive the closed settings.',
        )
      })
    })
  })

  describe('User role', () => {
    it('shows status, window line and warning read-only with no buttons', async () => {
      const todayEnd = new Date()
      todayEnd.setHours(16, 0, 0, 0)
      const timeStr = todayEnd.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })

      renderSection(
        makeStatus({
          status: 'applied',
          window: {
            id: 'w-1',
            opened_by: null,
            opened_at: new Date().toISOString(),
            ends_at: todayEnd.toISOString(),
            disconnect_on_close: false,
          },
          close_unconfirmed_since: new Date('2026-10-19T14:20:00Z').toISOString(),
        }),
        'user',
      )

      await waitFor(() => {
        expect(
          screen.getByText((content) => content.includes('Policy: Default · Applied')),
        ).toBeInTheDocument()
        expect(screen.getByText(new RegExp(`Reachable until ${timeStr}`))).toBeInTheDocument()
        expect(screen.getByText(/Closing… not confirmed by the device/)).toBeInTheDocument()
      })

      expect(screen.queryByRole('button', { name: 'Allow access' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Close now' })).toBeNull()
      expect(screen.queryByRole('checkbox')).toBeNull()
    })
  })

  describe('Error handling', () => {
    it('shows 409 server error message and keeps controls usable', async () => {
      vi.spyOn(api, 'POST').mockImplementation((path: string) => {
        if (path === '/admin/api/v1/devices/{id}/access-window') {
          return Promise.reject(new ApiError(409, 'window_open', 'close the access window first'))
        }
        return Promise.reject(new Error(`Unhandled POST ${path}`))
      })

      renderSection(makeStatus({ always_reachable: false, window: null, status: 'applied' }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Allow access' })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: 'Allow access' }))
      fireEvent.click(screen.getByRole('button', { name: 'Open window' }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('close the access window first')
      })

      // Controls stay enabled and usable
      expect(screen.getByRole('button', { name: 'Open window' })).not.toBeDisabled()
      expect(screen.getByLabelText('Duration')).not.toBeDisabled()
    })
  })
})
