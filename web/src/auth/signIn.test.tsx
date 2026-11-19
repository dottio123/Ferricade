import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../lib/queryKeys'

const calls: string[] = []
const post = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => async () => {
    calls.push('navigate')
  },
}))
vi.mock('../api/client', () => ({
  api: { POST: (path: string) => post(path) },
  unwrap: <T,>(p: Promise<T>) => p,
}))
vi.mock('../live/connection', () => ({
  suspendLive: () => calls.push('suspend'),
  resumeLive: () => calls.push('resume'),
}))

const { useSignOut } = await import('./signIn')
const { signInShown } = await import('./unauthorized')

let client: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  calls.length = 0
  post.mockReset()
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
})

describe('useSignOut', () => {
  // Live events can queue a refetch at any time; once the server has ended
  // the session it would answer 401 on the page still on screen.
  it('suspends live updates before it sends the logout', async () => {
    post.mockImplementation(async (path: string) => {
      calls.push(`POST ${path}`)
    })
    const { result } = renderHook(() => useSignOut(), { wrapper })
    await act(() => result.current.mutateAsync())
    expect(calls).toEqual(['suspend', 'POST /admin/api/v1/auth/logout', 'navigate'])
  })

  // The page on screen keeps its queries until the sign-in route's code has
  // loaded and React has swapped the pages; removed before that, a query
  // that re-renders (the live sessions' ticking timers) fetches again and
  // gets a 401 (e2e/sign-out.spec.ts failed this way in CI).
  it('forgets the cached data once sign-in shows, not when the navigation resolves', async () => {
    post.mockResolvedValue(undefined)
    client.setQueryData(queryKeys.me(), { signed: 'in' })
    client.setQueryData(queryKeys.sessions.all(), ['a session'])
    const { result } = renderHook(() => useSignOut(), { wrapper })
    await act(() => result.current.mutateAsync())
    expect(client.getQueryData(queryKeys.me())).toBeUndefined()
    expect(client.getQueryData(queryKeys.sessions.all())).toEqual(['a session'])
    signInShown()
    await vi.waitFor(() => expect(client.getQueryData(queryKeys.sessions.all())).toBeUndefined())
  })

  it('resumes live updates when the logout fails', async () => {
    post.mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => useSignOut(), { wrapper })
    await act(() => result.current.mutateAsync().catch(() => undefined))
    expect(calls).toEqual(['suspend', 'resume'])
  })
})
