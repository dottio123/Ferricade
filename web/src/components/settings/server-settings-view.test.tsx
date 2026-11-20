import { createMemoryHistory } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupServer } from 'msw/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import { installSessionHandlers } from '@/auth/unauthorized'
import { createQueryClient } from '@/lib/queryClient'
import { createMockDB } from '@/mocks/db'
import { readMockConfig } from '@/mocks/config'
import { createMockApi } from '@/mocks/handlers'
import { createAppRouter } from '@/router'

class SilentEventSource {
  readyState = 0
  addEventListener() {}
  close() {}
}

let stopServer = () => {}
beforeEach(() => vi.stubGlobal('EventSource', SilentEventSource))
afterEach(() => {
  cleanup()
  stopServer()
  vi.unstubAllGlobals()
})

function renderServerSettings(mock = '') {
  const db = createMockDB('small')
  const { handlers } = createMockApi(db, readMockConfig(mock))
  const server = setupServer(...handlers)
  server.listen({ onUnhandledRequest: 'error' })
  stopServer = () => server.close()
  const queryClient = createQueryClient()
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: ['/settings/server'] }),
  )
  installSessionHandlers(router, queryClient)
  render(<App router={router} queryClient={queryClient} />)
  return { db }
}

describe('Server settings', () => {
  it('saves the optional client API address', async () => {
    const { db } = renderServerSettings()
    const field = await screen.findByRole('textbox', { name: 'Client API address' })
    fireEvent.change(field, { target: { value: 'https://rustdesk-api.example.com/' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(db.server?.api_url).toBe('https://rustdesk-api.example.com'))
  })

  it('saves the connect link server switch', async () => {
    const { db } = renderServerSettings()
    const toggle = await screen.findByRole('switch', {
      name: 'Put the ID server and key in connect links',
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveAccessibleDescription(/plain rustdesk:\/\/<id> links/)
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(db.server?.links_include_server).toBe(false))
  })

  it('shows a server save error inline', async () => {
    renderServerSettings('?mock-fail=patchServer')
    const field = await screen.findByRole('textbox', { name: 'Client API address' })
    fireEvent.change(field, { target: { value: 'https://rustdesk-api.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(field).toHaveAttribute('aria-invalid', 'true')
  })
})
