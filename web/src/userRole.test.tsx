// The console as a User (?mock-role=user) sees it, and as an Owner still does.
import { createMemoryHistory } from '@tanstack/react-router'
import { cleanup, render, screen, within } from '@testing-library/react'
import { setupServer } from 'msw/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { installSessionHandlers } from './auth/unauthorized'
import { createQueryClient } from './lib/queryClient'
import { readMockConfig } from './mocks/config'
import { createMockDB } from './mocks/db'
import { createMockApi } from './mocks/handlers'
import { createAppRouter } from './router'

vi.setConfig({ testTimeout: 20_000 })

class SilentEventSource {
  readyState = 0
  addEventListener() {}
  close() {}
}

let stopServer: () => void = () => {}
const forbidden: string[] = []

beforeEach(() => {
  vi.stubGlobal('EventSource', SilentEventSource)
  forbidden.length = 0
})

afterEach(() => {
  cleanup()
  stopServer()
  vi.unstubAllGlobals()
})

function renderAt(path: string, mock: string) {
  const db = createMockDB('small')
  const { handlers, env } = createMockApi(db, readMockConfig(mock))
  const server = setupServer(...handlers)
  server.events.on('response:mocked', ({ request, response }) => {
    if (response.status === 403) forbidden.push(`${request.method} ${request.url}`)
  })
  server.listen({ onUnhandledRequest: 'error' })
  stopServer = () => server.close()
  const queryClient = createQueryClient()
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  installSessionHandlers(router, queryClient)
  render(<App router={router} queryClient={queryClient} />)
  return { router, env, db }
}

const heading = (name: string) =>
  screen.findByRole('heading', { level: 1, name }, { timeout: 8_000 })
const mainNav = () => within(screen.getByRole('navigation', { name: 'Main' }))

describe('as a User', () => {
  it('shows Command Center, Devices, Sessions and Audit Log, and no Groups, Tags, Policies or System Settings', async () => {
    renderAt('/', '?mock-role=user')
    await heading('Command Center')
    for (const name of ['Command Center', 'Devices', 'Sessions', 'Audit Log']) {
      expect(mainNav().getByRole('link', { name })).toBeInTheDocument()
    }
    expect(screen.queryByRole('link', { name: 'Groups' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Tags' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Policies' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'System Settings' })).toBeNull()
    expect(screen.queryByText(/pending/i, { selector: '[data-slot="badge"]' })).toBeNull()
    expect(forbidden).toEqual([])
  })

  it.each(['/settings', '/settings/users', '/groups', '/tags', '/devices/queue', '/policies'])(
    'redirects %s to / before its page renders',
    async (path) => {
      const { router } = renderAt(path, '?mock-role=user')
      expect(await heading('Command Center')).toBeInTheDocument()
      expect(router.state.location.pathname).toBe('/')
      expect(forbidden).toEqual([])
    },
  )

  it('lists the devices without state filter, selection or bulk actions', async () => {
    renderAt('/devices', '?mock-role=user')
    await heading('Devices')
    expect(await screen.findAllByRole('link', { name: /Details/ })).not.toHaveLength(0)
    expect(screen.queryByRole('combobox', { name: 'Filter by state' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Select/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^(Approve|Reject)/ })).toBeNull()
    expect(forbidden).toEqual([])
  })

  it('shows the device panel read-only, with Connect', async () => {
    const { db } = renderAt('/devices', '?mock-role=user')
    await heading('Devices')
    const granted = (await screen.findAllByRole('link', { name: /Details/ }))[0]!
    granted.click()
    await screen.findByRole('button', { name: 'Connect' }, { timeout: 8_000 })
    for (const name of [/Delete/, /Archive/, /Restore/, /Approve/, /Reject/, /Save changes/]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByLabelText(/Alias/)).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Add tag' })).toBeNull()
    expect(db.deviceRows.length).toBeGreaterThan(0)
    expect(forbidden).toEqual([])
  })

  it('titles the audit log "Your actions", with no actor filter', async () => {
    renderAt('/audit', '?mock-role=user')
    await heading('Audit Log')
    expect(screen.getByText('Your actions')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Filter by actor' })).toBeNull()
    expect(forbidden).toEqual([])
  })

  it('says so when no devices are assigned', async () => {
    renderAt('/', '?mock-role=user&mock-grants=none')
    await heading('Command Center')
    expect(
      await screen.findByText(
        'No devices are assigned to you yet. Ask an owner to assign devices or groups.',
        undefined,
        { timeout: 8_000 },
      ),
    ).toBeInTheDocument()
    expect(forbidden).toEqual([])
  })
})

describe('as an Owner', () => {
  it('still has every nav item and the state filter', async () => {
    renderAt('/devices', '')
    await heading('Devices')
    for (const name of ['Groups', 'Tags', 'Policies']) {
      expect(mainNav().getByRole('link', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: 'System Settings' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Filter by state' })).toBeInTheDocument()
  })
})
