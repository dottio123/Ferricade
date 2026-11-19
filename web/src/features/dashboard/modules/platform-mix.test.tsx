import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '@/api/client'
import { PlatformMixModule } from './platform-mix'

function renderModule(size: 'small' | 'medium') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.spyOn(api, 'GET').mockImplementation((path: string) => {
    if (path === '/admin/api/v1/stats/summary')
      return Promise.resolve({
        response: new Response(),
        data: {
          devices: { approved: 100 },
          os: [50, 20, 10, 8, 5, 4, 3].map((count, i) => ({ name: `OS ${i + 1}`, count })),
          versions: [],
        },
      } as never)
    return Promise.reject(new Error(`Unhandled GET ${path}`))
  })
  return render(
    <QueryClientProvider client={client}>
      <PlatformMixModule size={size} />
    </QueryClientProvider>,
  )
}

describe('PlatformMixModule', () => {
  beforeEach(() => vi.restoreAllMocks())

  it.each([
    ['small', '4 more', '20', '(20%)'],
    ['medium', '2 more', '7', '(7%)'],
  ] as const)('shows remaining platforms for %s modules', async (size, label, count, share) => {
    renderModule(size)
    await waitFor(() => expect(screen.getByText(label)).toBeInTheDocument())
    const row = screen.getByText(label).parentElement!
    expect(within(row).getByText(count)).toBeInTheDocument()
    expect(within(row).getByText(share)).toBeInTheDocument()
    expect(screen.queryByText('OS 7')).not.toBeInTheDocument()
  })
})
