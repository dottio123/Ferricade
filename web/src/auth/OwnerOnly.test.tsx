import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { api } from '@/api/client'
import { createQueryClient } from '@/lib/queryClient'
import { readMockConfig } from '@/mocks/config'
import { createMockDB } from '@/mocks/db'
import { createMockApi } from '@/mocks/handlers'
import { OwnerOnly } from './OwnerOnly'

let closeServer = () => {}
afterEach(() => {
  cleanup()
  closeServer()
})

async function start(search = '') {
  const db = createMockDB('small')
  const { handlers } = createMockApi(db, readMockConfig(search))
  const server = setupServer(...handlers)
  server.listen({ onUnhandledRequest: 'error' })
  closeServer = () => server.close()
  await api.GET('/admin/api/v1/auth/me')
}

function renderOwnerOnly() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <OwnerOnly action="manage users">
        <div>Owner content</div>
      </OwnerOnly>
    </QueryClientProvider>,
  )
}

describe('OwnerOnly', () => {
  it('renders a muted status notice for non-owners', async () => {
    await start('?mock-role=admin')
    renderOwnerOnly()
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('Only owners can manage users.')
    expect(screen.queryByText('Owner content')).toBeNull()
  })

  it('renders children for owners', async () => {
    await start()
    renderOwnerOnly()
    expect(await screen.findByText('Owner content')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
