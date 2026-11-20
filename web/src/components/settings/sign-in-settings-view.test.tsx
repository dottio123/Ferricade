import { describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryHistory } from '@tanstack/react-router'
import { setupServer } from 'msw/node'
import { afterEach, vi } from 'vitest'
import type { components } from '@/api/schema'
import { App } from '@/App'
import { installSessionHandlers } from '@/auth/unauthorized'
import { createQueryClient } from '@/lib/queryClient'
import { createMockDB } from '@/mocks/db'
import { readMockConfig } from '@/mocks/config'
import { createMockApi } from '@/mocks/handlers'
import { createAppRouter } from '@/router'
import { oidcPatch } from './sign-in-settings-view'

vi.setConfig({ testTimeout: 15_000 })
class SilentEventSource {
  readyState = 0
  addEventListener() {}
  close() {}
}
// jsdom lacks scrollIntoView, which the Radix Select calls when it opens.
Element.prototype.scrollIntoView = vi.fn()
let closeServer = () => {}
afterEach(() => {
  cleanup()
  closeServer()
  vi.unstubAllGlobals()
})

function renderSettings(search = '') {
  vi.stubGlobal('EventSource', SilentEventSource)
  const db = createMockDB('small')
  const { handlers } = createMockApi(db, readMockConfig(search))
  const server = setupServer(...handlers)
  server.listen({ onUnhandledRequest: 'error' })
  closeServer = () => server.close()
  const queryClient = createQueryClient()
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: [`/settings/sign-in${search}`] }),
  )
  installSessionHandlers(router, queryClient)
  render(<App router={router} queryClient={queryClient} />)
  return { db }
}

const initial: components['schemas']['OIDCSettings'] = {
  enabled: false,
  display_name: 'Dex',
  issuer: 'https://example.com',
  client_id: 'ferricade',
  client_secret_set: true,
  redirect_uri: 'https://ferricade.example/admin/api/v1/auth/oidc/callback',
  groups_claim: 'groups',
  owner_groups: ['owners'],
  admin_groups: [],
  user_groups: [],
  jit_enabled: false,
  last_test: null,
  updated_at: null,
}

describe('OIDC settings patch', () => {
  it('sends only changed fields and never sends a saved secret', () => {
    expect(oidcPatch(initial, { ...initial, display_name: 'Authentik' }, '')).toEqual({
      display_name: 'Authentik',
    })
    expect(oidcPatch(initial, initial, 'new-secret')).toEqual({ client_secret: 'new-secret' })
    expect(oidcPatch(initial, initial, '')).toEqual({})
  })
  it('includes changed group lists and switches', () => {
    expect(
      oidcPatch(initial, { ...initial, owner_groups: ['admins'], jit_enabled: true }, ''),
    ).toEqual({ owner_groups: ['admins'], jit_enabled: true })
  })
})

async function pickDuration(name: RegExp) {
  const trigger = await screen.findByRole('combobox', { name: 'Sign-in duration' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name }))
  return trigger
}

describe('Sign-in settings view', () => {
  it('shows the stored duration and saves a changed lifetime', async () => {
    const { db } = renderSettings()
    expect(
      await screen.findByText('Sign-in duration', {
        exact: true,
        selector: '[data-slot="card-title"]',
      }),
    ).toBeInTheDocument()
    const trigger = await screen.findByRole('combobox', { name: 'Sign-in duration' })
    expect(trigger).toHaveTextContent('Until the browser closes')
    expect(
      screen.getByText(/Signed out 5 minutes after the last console tab closes/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save duration' })).toBeDisabled()
    const puts: string[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : null
      const method = req?.method ?? init?.method ?? 'GET'
      const url = req?.url ?? String(input)
      if (method === 'PUT' && url.includes('/settings/sessions')) puts.push(url)
      return realFetch(input, init)
    })
    await pickDuration(/7 days/)
    expect(trigger).toHaveTextContent('7 days')
    expect(screen.getByText(/Stays signed in across browser restarts/)).toBeInTheDocument()
    expect(screen.queryByText(/Signed out 5 minutes after/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save duration' }))
    await waitFor(() => expect(screen.getByText('Sign-in duration saved')).toBeInTheDocument())
    expect(trigger).toHaveTextContent('7 days')
    expect(db.sessionSettings.lifetime).toBe('7d')
    expect(puts).toHaveLength(1)
  })

  it('shows the duration read-only to Admins', async () => {
    renderSettings('?mock-role=admin')
    expect(await screen.findByText('Only owners can manage sign-in settings.')).toBeInTheDocument()
    expect(
      screen.queryByText('Sign-in duration', { exact: true, selector: '[data-slot="card-title"]' }),
    ).not.toBeInTheDocument()
  })

  it('shows the API error when saving a duration fails', async () => {
    renderSettings('?mock-fail=putSessionSettings')
    expect(
      await screen.findByText('Sign-in duration', {
        exact: true,
        selector: '[data-slot="card-title"]',
      }),
    ).toBeInTheDocument()
    await pickDuration(/8 hours/)
    fireEvent.click(screen.getByRole('button', { name: 'Save duration' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('putSessionSettings')
  })

  it('shows an unlisted saved duration as its raw value with neutral help', async () => {
    const { db } = renderSettings()
    ;(db.sessionSettings as { lifetime: string }).lifetime = '90d'
    const trigger = await screen.findByRole('combobox', { name: 'Sign-in duration' })
    expect(trigger).toHaveTextContent('90d')
    expect(screen.queryByText(/Signed out 5 minutes after/)).not.toBeInTheDocument()
    expect(
      screen.getByText('Custom sign-in duration configured on the server.'),
    ).toBeInTheDocument()
  })

  it('keeps a saved secret write-only, saves changed fields, and renders test results', async () => {
    renderSettings()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign-In' }, { timeout: 5_000 }),
    ).toBeInTheDocument()
    fireEvent.change(await screen.findByLabelText('Button name', {}, { timeout: 5_000 }), {
      target: { value: 'Dex' },
    })
    fireEvent.change(screen.getByLabelText('Issuer URL'), {
      target: { value: 'https://example.com' },
    })
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'ferricade' } })
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'first-secret' } })
    fireEvent.change(screen.getByLabelText('Owner groups'), { target: { value: 'authors' } })
    fireEvent.keyDown(screen.getByLabelText('Owner groups'), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.getByText('A secret is saved')).toBeInTheDocument(), {
      timeout: 5_000,
    })
    expect(screen.queryByLabelText('Client secret')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(
      await screen.findByText('Connection succeeded.', {}, { timeout: 5_000 }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Replace secret' }))
    expect(screen.getByLabelText('Client secret')).toHaveValue('')
  })

  it('maps provider groups to the User role and sends only user_groups', async () => {
    renderSettings()
    const field = await screen.findByLabelText('User groups', {}, { timeout: 5_000 })
    expect(screen.getByLabelText('Admin groups')).toBeInTheDocument()
    expect(screen.getByText(/at least one owner, admin or user group/i)).toBeInTheDocument()
    fireEvent.change(field, { target: { value: 'helpdesk' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.getByText('Sign-in settings saved')).toBeInTheDocument(), {
      timeout: 5_000,
    })
    expect(
      screen.getByRole('button', { name: 'Remove helpdesk from User groups' }),
    ).toBeInTheDocument()
  })
})
