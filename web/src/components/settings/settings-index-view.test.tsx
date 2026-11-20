import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsIndexView } from './settings-index-view'
import { api } from '@/api/client'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

const mockUseMe = vi.fn(() => ({ data: { user: { role: 'owner' } } }))

vi.mock('@/auth/session', () => ({
  useMe: () => mockUseMe(),
}))

vi.mock('@/components/client-config', () => ({
  ClientConfig: () => <div data-testid="client-config">Config</div>,
}))

describe('SettingsIndexView', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('has no Client policies card and renders card titles in Title Case', async () => {
    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/server/client-config') {
        return Promise.resolve({
          response: new Response(),
          data: {
            server: 'custom',
            custom: { host: '127.0.0.1', port: 21116, key: 'abc' },
            rustdesk: { host: '127.0.0.1', port: 21116, key: 'abc' },
          },
        } as never)
      }
      return Promise.reject(new Error(`Unhandled GET ${path}`))
    })

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={client}>
        <SettingsIndexView />
      </QueryClientProvider>,
    )

    // The Client policies card must be removed
    expect(screen.queryByRole('link', { name: /policies/i })).toBeNull()

    // Title Case headings and card titles
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Client Configuration' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Fleet Thresholds')).toBeInTheDocument()
    expect(screen.getByText('Client Setup')).toBeInTheDocument()
    expect(screen.getByText('Sign-In')).toBeInTheDocument()
    expect(screen.getByText('Log Export')).toBeInTheDocument()
    expect(screen.getByText('Global ID Allowlist')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Send the audit trail and remote sessions to a log file or a syslog collector.',
      ),
    ).toBeInTheDocument()
  })

  it('renders Log Export card for both owner and admin', async () => {
    vi.spyOn(api, 'GET').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/server/client-config') {
        return Promise.resolve({
          response: new Response(),
          data: {
            server: 'custom',
            custom: { host: '127.0.0.1', port: 21116, key: 'abc' },
            rustdesk: { host: '127.0.0.1', port: 21116, key: 'abc' },
          },
        } as never)
      }
      return Promise.reject(new Error(`Unhandled GET ${path}`))
    })

    // Test as admin
    mockUseMe.mockReturnValue({ data: { user: { role: 'admin' } } } as never)

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={client}>
        <SettingsIndexView />
      </QueryClientProvider>,
    )

    // Admin should see Log Export and Deployment, but not Users or Sign-In
    const logExportLink = screen.getByRole('link', { name: /log export/i })
    expect(logExportLink).toBeInTheDocument()
    expect(logExportLink).toHaveAttribute('href', '/settings/log-export')

    expect(screen.getByText('Deployment')).toBeInTheDocument()
    expect(screen.queryByText('Users')).toBeNull()
    expect(screen.queryByText('Sign-In')).toBeNull()
  })
})
