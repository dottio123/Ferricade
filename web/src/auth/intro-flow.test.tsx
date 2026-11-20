import { createMemoryHistory } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { createQueryClient } from '../lib/queryClient'
import { DEMO, readMockConfig } from '../mocks/config'
import { createMockDB } from '../mocks/db'
import { createMockApi } from '../mocks/handlers'
import type { Env } from '../mocks/route'
import { createAppRouter } from '../router'
import { INTRO_FLAG_KEY, setIntroFlag } from './intro-flag'
import { installSessionHandlers } from './unauthorized'

vi.setConfig({ testTimeout: 15_000 })

class SilentEventSource {
  readyState = 0
  addEventListener() {}
  close() {}
}

let stopServer: () => void = () => {}

beforeEach(() => {
  vi.stubGlobal('EventSource', SilentEventSource)
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  stopServer()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

function renderApp(
  path: string,
  opts: { mock?: string; session?: (env: Env) => void; delaySetupMs?: number } = {},
) {
  const db = createMockDB('small')
  const { handlers, env } = createMockApi(db, readMockConfig(opts.mock ?? ''))
  opts.session?.(env)
  const extra = opts.delaySetupMs
    ? [
        http.get('/setup/status', async () => {
          await new Promise((resolve) => setTimeout(resolve, opts.delaySetupMs))
          return HttpResponse.json({ setup_complete: true })
        }),
      ]
    : []
  const server = setupServer(...extra, ...handlers)
  server.listen({ onUnhandledRequest: 'error' })
  stopServer = () => server.close()
  const queryClient = createQueryClient()
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  installSessionHandlers(router, queryClient)
  const view = render(<App router={router} queryClient={queryClient} />)
  return { router, env, queryClient, server, view }
}

describe('intro and boot loader integration', () => {
  it('shows the F loader while the initial API call resolves, then renders the app', async () => {
    renderApp('/', { delaySetupMs: 120 })
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull()
  })

  it('plays the intro once after password sign-in, clears the flag, and skips on reload', async () => {
    renderApp('/sign-in', {
      mock: '?mock-session=optional',
      session: (env) => {
        env.session.userId = null
      },
    })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alex' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: DEMO.password } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="brand-intro"]')).not.toBeNull()
    })
    expect(sessionStorage.getItem(INTRO_FLAG_KEY)).toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="brand-intro"]')).toBeNull()
    })
    expect(document.activeElement).toBe(document.body)

    // Simulated reload: new router/queryClient with same sessionStorage does not replay intro.
    cleanup()
    renderApp('/')
    expect(await screen.findByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible()
    expect(document.querySelector('[data-slot="brand-intro"]')).toBeNull()
  })

  it('clears a stale intro flag when /sign-in mounts and sets it on OIDC click', async () => {
    setIntroFlag()
    renderApp('/sign-in', {
      mock: '?mock-oidc=on',
      session: (env) => {
        env.session.userId = null
      },
    })
    await screen.findByRole('heading', { level: 1, name: 'Sign in' })
    await vi.waitFor(() => {
      expect(sessionStorage.getItem(INTRO_FLAG_KEY)).toBeNull()
    })

    const oidcLink = await screen.findByRole('link', { name: 'Sign in with Authentik' })
    oidcLink.addEventListener('click', (e) => e.preventDefault())
    act(() => {
      fireEvent.click(oidcLink)
    })
    expect(sessionStorage.getItem(INTRO_FLAG_KEY)).toBe('1')
  })
})
