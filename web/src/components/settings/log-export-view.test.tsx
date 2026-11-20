import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { components } from '@/api/schema'
import { ApiError } from '@/api/errors'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LogExportView } from './log-export-view'

type LogExport = components['schemas']['LogExport']

const apiMock = vi.hoisted(() => ({
  GET: vi.fn(),
  PUT: vi.fn(),
  POST: vi.fn(),
}))

const sessionMock = vi.hoisted(() => ({
  useMe: vi.fn(),
}))

const toastMock = vi.hoisted(() => ({
  toast: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: apiMock,
  unwrap: async (promise: Promise<{ data?: unknown; error?: unknown; response?: Response }>) => {
    const res = await promise
    if (res.error) {
      const errObj = res.error as { error?: { code?: string; message?: string } }
      throw new ApiError(
        res.response?.status ?? 400,
        (errObj.error?.code as never) ?? 'bad_request',
        errObj.error?.message ?? 'API error',
      )
    }
    return res.data
  },
}))

vi.mock('@/auth/session', () => ({
  useMe: () => sessionMock.useMe(),
}))

vi.mock('@/components/ui/toast', () => ({
  useToast: () => toastMock,
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

const defaultLogExport: LogExport = {
  settings: {
    file: { enabled: false },
    syslog: {
      enabled: false,
      host: '',
      port: 6514,
      tls: true,
      ca_pem: '',
      facility: 'local0',
      format: 'json',
    },
  },
  status: {
    file: {
      pending: 0,
      last_delivered_at: null,
      last_error: null,
      last_error_at: null,
    },
    syslog: {
      pending: 0,
      last_delivered_at: null,
      last_error: null,
      last_error_at: null,
    },
  },
  updated_at: '2026-10-21T14:00:00Z',
  updated_by: { id: 'usr-1', display_name: 'Alice Owner' },
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  )
}

describe('LogExportView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionMock.useMe.mockReturnValue({ data: { user: { role: 'owner' } } })
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/log-export') {
        return Promise.resolve({
          data: structuredClone(defaultLogExport),
          error: undefined,
          response: new Response(),
        })
      }
      return Promise.reject(new Error(`Unhandled GET ${path}`))
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders page layout, cards, container path, Zabbix hint, and status', async () => {
    renderWithClient(<LogExportView />)

    expect(await screen.findByText('Log File')).toBeInTheDocument()
    expect(screen.getByText('Syslog')).toBeInTheDocument()

    // Container path display
    expect(screen.getByDisplayValue('/var/log/ferricade/events.jsonl')).toBeInTheDocument()

    // Zabbix hint link
    const zabbixLink = screen.getByRole('link', { name: /how to set it up/i })
    expect(zabbixLink).toBeInTheDocument()
    expect(zabbixLink).toHaveAttribute('href', 'https://github.com/dottio123/ferricade#log-export')
    expect(zabbixLink).toHaveAttribute('target', '_blank')

    // Status titles
    expect(screen.getByText('Log File Status')).toBeInTheDocument()
    expect(screen.getByText('Syslog Status')).toBeInTheDocument()

    // Last changed info
    expect(screen.getByText(/Last changed by Alice Owner/i)).toBeInTheDocument()
  })

  it('allows owner to toggle switches, edit settings, and saves whole settings object', async () => {
    apiMock.PUT.mockImplementation((path: string, { body }: { body: unknown }) => {
      if (path === '/admin/api/v1/settings/log-export') {
        return Promise.resolve({
          data: {
            ...defaultLogExport,
            settings: body,
            updated_at: '2026-10-22T08:00:00Z',
          },
          error: undefined,
          response: new Response(),
        })
      }
      return Promise.reject(new Error(`Unhandled PUT ${path}`))
    })

    renderWithClient(<LogExportView />)
    await screen.findByText('Log File')

    // Initially save button is disabled (no unsaved changes)
    const saveButton = screen.getByRole('button', { name: 'Save changes' })
    expect(saveButton).toBeDisabled()

    // Toggle log file switch
    const logFileSwitch = screen.getByRole('switch', { name: 'Enable log file export' })
    fireEvent.click(logFileSwitch)

    // Save button becomes enabled
    expect(saveButton).toBeEnabled()

    // Enter syslog host
    const hostInput = screen.getByLabelText('Host')
    fireEvent.change(hostInput, { target: { value: 'syslog.corp.local' } })

    // Click Save changes
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(apiMock.PUT).toHaveBeenCalledWith('/admin/api/v1/settings/log-export', {
        body: {
          file: { enabled: true },
          syslog: {
            enabled: false,
            host: 'syslog.corp.local',
            port: 6514,
            tls: true,
            ca_pem: '',
            facility: 'local0',
            format: 'json',
          },
        },
      })
    })

    expect(toastMock.toast).toHaveBeenCalledWith({ title: 'Log export settings saved' })
  })

  it('adjusts default port 514 <-> 6514 when TLS is toggled, but preserves custom port', async () => {
    renderWithClient(<LogExportView />)
    await screen.findByText('Log File')

    const tlsSwitch = screen.getByRole('switch', { name: 'Use TLS' })
    const portInput = screen.getByLabelText('Port')

    // Initial state: TLS is true, port is 6514
    expect(tlsSwitch).toHaveAttribute('data-state', 'checked')
    expect(portInput).toHaveValue(6514)

    // Toggle TLS off -> port becomes 514
    fireEvent.click(tlsSwitch)
    expect(tlsSwitch).toHaveAttribute('data-state', 'unchecked')
    expect(portInput).toHaveValue(514)

    // Toggle TLS on -> port becomes 6514
    fireEvent.click(tlsSwitch)
    expect(tlsSwitch).toHaveAttribute('data-state', 'checked')
    expect(portInput).toHaveValue(6514)

    // Set custom port 1514
    fireEvent.change(portInput, { target: { value: '1514' } })
    expect(portInput).toHaveValue(1514)

    // Toggle TLS off -> custom port preserved
    fireEvent.click(tlsSwitch)
    expect(tlsSwitch).toHaveAttribute('data-state', 'unchecked')
    expect(portInput).toHaveValue(1514)

    // Toggle TLS on -> custom port still preserved
    fireEvent.click(tlsSwitch)
    expect(tlsSwitch).toHaveAttribute('data-state', 'checked')
    expect(portInput).toHaveValue(1514)
  })

  it('displays 400 validation error naming syslog.host at the host field', async () => {
    apiMock.PUT.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/log-export') {
        return Promise.resolve({
          error: {
            error: {
              code: 'bad_request',
              message: 'syslog.host: required when enabled',
            },
          },
          response: new Response(null, { status: 400 }),
        })
      }
      return Promise.reject(new Error(`Unhandled PUT ${path}`))
    })

    renderWithClient(<LogExportView />)
    await screen.findByText('Log File')

    // Toggle syslog enabled
    const syslogSwitch = screen.getByRole('switch', { name: 'Enable syslog export' })
    fireEvent.click(syslogSwitch)

    // Submit form
    const saveButton = screen.getByRole('button', { name: 'Save changes' })
    fireEvent.click(saveButton)

    // Error should be shown at host field
    const hostError = await screen.findByRole('alert')
    expect(hostError).toHaveTextContent('syslog.host: required when enabled')

    // Editing host clears the field error
    const hostInput = screen.getByLabelText('Host')
    fireEvent.change(hostInput, { target: { value: 'syslog.example.com' } })
    expect(screen.queryByText('syslog.host: required when enabled')).toBeNull()
  })

  it('disables test button while form has unsaved edits, and shows hint to save first', async () => {
    renderWithClient(<LogExportView />)
    await screen.findByText('Log File')

    const testButtons = screen.getAllByRole('button', { name: 'Send test event' })
    expect(testButtons).toHaveLength(2)
    const fileTestBtn = testButtons[0]!
    const syslogTestBtn = testButtons[1]!

    // When clean: test buttons are enabled, no hint
    expect(fileTestBtn).toBeEnabled()
    expect(syslogTestBtn).toBeEnabled()
    expect(screen.queryByText('Save changes first to test with updated settings.')).toBeNull()

    // Make a change
    const logFileSwitch = screen.getByRole('switch', { name: 'Enable log file export' })
    fireEvent.click(logFileSwitch)

    // Now dirty: test buttons are disabled and hint appears
    expect(fileTestBtn).toBeDisabled()
    expect(syslogTestBtn).toBeDisabled()
    expect(screen.getAllByText('Save changes first to test with updated settings.')).toHaveLength(2)
  })

  it('sends test event and displays ok result and error text inline', async () => {
    apiMock.POST.mockImplementation((path: string, { body }: { body: { output: string } }) => {
      if (path === '/admin/api/v1/settings/log-export/test') {
        if (body.output === 'file') {
          return Promise.resolve({
            data: { ok: true, error: null },
            error: undefined,
            response: new Response(),
          })
        }
        if (body.output === 'syslog') {
          return Promise.resolve({
            data: { ok: false, error: 'dial tcp 10.0.0.5:6514: connection refused' },
            error: undefined,
            response: new Response(),
          })
        }
      }
      return Promise.reject(new Error(`Unhandled POST ${path}`))
    })

    renderWithClient(<LogExportView />)
    await screen.findByText('Log File')

    const testButtons = screen.getAllByRole('button', { name: 'Send test event' })
    expect(testButtons).toHaveLength(2)
    const fileTestBtn = testButtons[0]!
    const syslogTestBtn = testButtons[1]!

    // Test file output
    fireEvent.click(fileTestBtn)
    await waitFor(() => {
      expect(apiMock.POST).toHaveBeenCalledWith('/admin/api/v1/settings/log-export/test', {
        body: { output: 'file' },
      })
    })
    expect(await screen.findByText('Test event delivered')).toBeInTheDocument()

    // Test syslog output
    fireEvent.click(syslogTestBtn)
    await waitFor(() => {
      expect(apiMock.POST).toHaveBeenCalledWith('/admin/api/v1/settings/log-export/test', {
        body: { output: 'syslog' },
      })
    })
    const syslogAlert = await screen.findByRole('alert')
    expect(syslogAlert).toHaveTextContent('dial tcp 10.0.0.5:6514: connection refused')
  })

  it('renders read-only view for admin: controls disabled, test buttons hidden, and notice shown', async () => {
    sessionMock.useMe.mockReturnValue({ data: { user: { role: 'admin' } } })

    renderWithClient(<LogExportView />)
    await screen.findByText('Log File')

    // Owner-only banner notice
    expect(
      screen.getByText(
        'Only owners can edit log export settings. Values are displayed in read-only mode.',
      ),
    ).toBeInTheDocument()

    // Switches disabled
    expect(screen.getByRole('switch', { name: 'Enable log file export' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Enable syslog export' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Use TLS' })).toBeDisabled()

    // Inputs disabled
    expect(screen.getByLabelText('Host')).toBeDisabled()
    expect(screen.getByLabelText('Port')).toBeDisabled()
    expect(screen.getByLabelText('CA certificate')).toBeDisabled()

    // Test buttons hidden
    expect(screen.queryByRole('button', { name: 'Send test event' })).toBeNull()

    // Save changes button hidden
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })

  it('renders loading state and error state with retry', async () => {
    // 1. Loading state
    apiMock.GET.mockReturnValue(new Promise(() => {}))
    const { unmount } = renderWithClient(<LogExportView />)
    expect(screen.getByRole('heading', { level: 1, name: 'Log Export' })).toBeInTheDocument()
    unmount()

    // 2. Error state
    apiMock.GET.mockReturnValue(
      Promise.resolve({
        error: { error: { message: 'Network offline' } },
        response: new Response(null, { status: 500 }),
      }),
    )

    renderWithClient(<LogExportView />)
    expect(await screen.findByText('Failed to load log export settings')).toBeInTheDocument()
    const retryBtn = screen.getByRole('button', { name: /try again/i })
    expect(retryBtn).toBeInTheDocument()

    // Clicking retry refetches
    apiMock.GET.mockReturnValue(
      Promise.resolve({
        data: defaultLogExport,
        error: undefined,
        response: new Response(),
      }),
    )
    fireEvent.click(retryBtn)
    expect(await screen.findByText('Log File')).toBeInTheDocument()
  })
})
