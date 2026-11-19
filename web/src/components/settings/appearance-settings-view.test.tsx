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

vi.setConfig({ testTimeout: 15_000 })

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
  document.documentElement.removeAttribute('data-palette')
  document.documentElement.removeAttribute('data-theme')
})

function renderAppearance(mock = '', toastSeconds: 0 | 3 | 5 | 10 | 30 = 5) {
  const db = createMockDB('small')
  const userId = db.users[0]!.id
  db.savePreferences(userId, { ...db.preferencesFor(userId), toast_seconds: toastSeconds })
  const { handlers, env } = createMockApi(db, readMockConfig(mock))
  const server = setupServer(...handlers)
  server.listen({ onUnhandledRequest: 'error' })
  stopServer = () => server.close()
  const queryClient = createQueryClient()
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: ['/account/appearance'] }),
  )
  installSessionHandlers(router, queryClient)
  render(<App router={router} queryClient={queryClient} />)
  return { db, env }
}

// Under three full-suite jobs, Devices took 3,506 ms and Command Center 1,450 ms to appear.
const findByRole = (role: string, options?: Parameters<typeof screen.findByRole>[1]) =>
  screen.findByRole(role, options, { timeout: 5_000 })
const findAllByRole = (role: string, options?: Parameters<typeof screen.findAllByRole>[1]) =>
  screen.findAllByRole(role, options, { timeout: 5_000 })

describe('Appearance settings', () => {
  it('announces the loading state', async () => {
    renderAppearance('?mock-delay=1000')
    expect(await findByRole('status', { name: 'Loading appearance settings' })).toBeInTheDocument()
  })

  it('shows the ordered palettes with Default selected for a new user', async () => {
    renderAppearance()
    expect(await findByRole('heading', { level: 1, name: 'Appearance' })).toBeInTheDocument()
    const radios = await findAllByRole('radio', {
      name: /Default|Graphite|Ocean|Violet|Moss|Sandstone/,
    })
    expect(
      radios
        .filter((radio) => (radio as HTMLInputElement).name === 'palette')
        .map((radio) => radio.getAttribute('value')),
    ).toEqual(['default', 'graphite', 'ocean', 'violet', 'moss', 'sandstone'])
    expect(screen.getByRole('radio', { name: 'Default' })).toBeChecked()
  })

  it('applies and saves Ocean', async () => {
    const { db, env } = renderAppearance()
    fireEvent.click(await findByRole('radio', { name: 'Ocean' }))
    await waitFor(() => expect(db.preferencesFor(env.session.userId!).palette).toBe('ocean'), {
      timeout: 5_000,
    })
    expect(document.documentElement.dataset.palette).toBe('ocean')
  })

  it('restores Default and shows an error when saving fails', async () => {
    renderAppearance('?mock-fail=putPreferences')
    fireEvent.click(await findByRole('radio', { name: 'Violet' }))
    expect(await findByRole('alert')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Default' })).toBeChecked(), {
      timeout: 5_000,
    })
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false)
  })

  it('reflects the stored mode', async () => {
    renderAppearance()
    await findByRole('heading', { level: 1, name: 'Appearance' })
    expect(await findByRole('radio', { name: 'System' })).toBeChecked()
  })

  it('shows and saves the notification duration preference', async () => {
    const { db, env } = renderAppearance('', 10)
    const duration = await screen.findByRole('combobox', { name: 'Hide notifications after' })
    expect(duration).toHaveValue('10')
    expect(screen.getByRole('option', { name: '3 seconds' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '5 seconds (default)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '10 seconds' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '30 seconds' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Until I close them' })).toBeInTheDocument()
    fireEvent.change(duration, { target: { value: '0' } })
    await waitFor(() => {
      expect(db.preferencesFor(env.session.userId!).toast_seconds).toBe(0)
    })
  })
})
