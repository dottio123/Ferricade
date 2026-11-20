import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { delay, http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterEach, describe, expect, it } from 'vitest'
import { createMockDB } from '@/mocks/db'
import { readMockConfig } from '@/mocks/config'
import { createMockApi } from '@/mocks/handlers'
import { createQueryClient } from '@/lib/queryClient'
import { queryKeys } from '@/lib/queryKeys'
import { csrf } from '@/api/csrf'
import { useThemeSwitch } from './use-theme-switch'

afterEach(() => {
  cleanup()
  csrf.clear()
  document.documentElement.removeAttribute('data-palette')
  document.documentElement.removeAttribute('data-theme')
})

function setup(mock = '') {
  const db = createMockDB('small')
  const { handlers, env } = createMockApi(db, readMockConfig(mock))
  csrf.set(env.session.csrf)
  const server = setupServer(...handlers)
  server.listen({ onUnhandledRequest: 'error' })
  const client = createQueryClient()
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const hook = renderHook(() => useThemeSwitch(), { wrapper })
  return { ...hook, db, env, client, server }
}

describe('useThemeSwitch palette', () => {
  it('sets and saves a palette', async () => {
    const { result, db, env, server } = setup()
    try {
      await waitFor(() => expect(result.current.isLoading).toBe(false))
      act(() => result.current.setPalette('ocean'))
      await waitFor(() => expect(db.preferencesFor(env.session.userId!).palette).toBe('ocean'))
      expect(document.documentElement.dataset.palette).toBe('ocean')
    } finally {
      server.close()
    }
  })

  it('keeps consecutive palette and mode changes together', async () => {
    const { result, db, env, client, server } = setup()
    try {
      await waitFor(() => expect(result.current.isLoading).toBe(false))
      let writes = 0
      let completedWrites = 0
      const submittedBodies: Parameters<typeof db.savePreferences>[1][] = []
      server.use(
        http.put('/admin/api/v1/me/preferences', async ({ request }) => {
          writes += 1
          const submitted = (await request.json()) as Parameters<typeof db.savePreferences>[1]
          submittedBodies.push(submitted)
          if (writes === 1) await delay(200)
          const saved = db.savePreferences(env.session.userId!, submitted)
          completedWrites += 1
          return HttpResponse.json(saved)
        }),
      )
      act(() => result.current.setPalette('ocean'))
      await waitFor(() => expect(writes).toBe(1))
      act(() => result.current.setTheme('dark'))
      await waitFor(() => expect(completedWrites).toBe(2))
      expect(submittedBodies.map(({ theme, palette }) => ({ theme, palette }))).toEqual([
        { theme: 'system', palette: 'ocean' },
        { theme: 'dark', palette: 'ocean' },
      ])
      expect(db.preferencesFor(env.session.userId!)).toMatchObject({
        palette: 'ocean',
        theme: 'dark',
      })
      expect(client.getQueryData(queryKeys.preferences())).toMatchObject({
        palette: 'ocean',
        theme: 'dark',
      })
    } finally {
      server.close()
    }
  })

  it('restores the previous appearance after a failed save', async () => {
    const { result, server } = setup('?mock-fail=putPreferences')
    try {
      await waitFor(() => expect(result.current.isLoading).toBe(false))
      act(() => result.current.setPalette('violet'))
      await waitFor(() => expect(result.current.error).toBeTruthy())
      expect(document.documentElement.dataset.palette).toBe('ferricade')
    } finally {
      server.close()
    }
  })

  it('applies a palette received through a preferences refetch', async () => {
    const { result, client, server } = setup()
    try {
      await waitFor(() => expect(result.current.isLoading).toBe(false))
      const current = client.getQueryData(queryKeys.preferences())!
      client.setQueryData(queryKeys.preferences(), { ...current, palette: 'graphite' })
      await waitFor(() => expect(document.documentElement.dataset.palette).toBe('graphite'))
    } finally {
      server.close()
    }
  })
})
