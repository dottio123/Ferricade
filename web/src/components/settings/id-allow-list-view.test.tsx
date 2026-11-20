import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdAllowListView } from './id-allow-list-view'
import { api } from '@/api/client'
import { ToasterProvider } from '@/components/ui/toast'

const mockUseMe = vi.fn(() => ({ data: { user: { role: 'owner' } } }))
vi.mock('@/auth/session', () => ({ useMe: () => mockUseMe() }))

describe('IdAllowListView', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('allows owners to edit and shows admins the same list read-only', async () => {
    vi.spyOn(api, 'GET').mockResolvedValue({
      response: new Response(),
      data: { ids: ['Office_1'] },
    } as never)
    const renderView = () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      render(
        <QueryClientProvider client={client}>
          <ToasterProvider>
            <IdAllowListView />
          </ToasterProvider>
        </QueryClientProvider>,
      )
    }

    renderView()
    expect(await screen.findByRole('textbox', { name: 'Add RustDesk ID' })).toBeInTheDocument()
    expect(screen.getAllByText('Global ID Allowlist')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Save Global ID Allowlist' })).toBeInTheDocument()

    cleanup()
    mockUseMe.mockReturnValue({ data: { user: { role: 'admin' } } } as never)
    renderView()
    expect(await screen.findByText('Office_1')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Add RustDesk ID' })).toBeNull()
  })

  it('renders nothing for the user role', () => {
    mockUseMe.mockReturnValue({ data: { user: { role: 'user' } } } as never)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={client}>
        <IdAllowListView />
      </QueryClientProvider>,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
