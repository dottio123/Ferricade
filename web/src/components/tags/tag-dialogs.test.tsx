import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToasterProvider } from '@/components/ui/toast'
import { TagFormDialog } from './tag-dialogs'

const apiMock = vi.hoisted(() => ({
  POST: vi.fn(),
  PATCH: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: apiMock,
  unwrap: (result: unknown) => result,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('TagFormDialog toasts', () => {
  it('shows no toast while pending or rejected, and exactly one after create/edit succeeds', async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const wrap = (node: React.ReactNode) => (
      <QueryClientProvider client={client}>
        <ToasterProvider>{node}</ToasterProvider>
      </QueryClientProvider>
    )

    // Create: reject first -> no toast
    const createFail = deferred<unknown>()
    apiMock.POST.mockReturnValueOnce(createFail.promise)
    const r1 = render(wrap(<TagFormDialog open onOpenChange={() => {}} />))
    fireEvent.change(screen.getByLabelText('Tag name'), { target: { value: 'kiosk' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create tag' }))
    expect(screen.queryByText('Tag created')).toBeNull()
    createFail.reject(new Error('Duplicate tag'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Tag created')).toBeNull()

    // Create: pending -> no toast, then resolve -> exactly one
    const createOk = deferred<{ id: string; name: string; color: number }>()
    apiMock.POST.mockReturnValueOnce(createOk.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Create tag' }))
    await waitFor(() => expect(apiMock.POST).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Tag created')).toBeNull()
    createOk.resolve({ id: 't1', name: 'kiosk', color: 0x2196f3 })
    expect(await screen.findAllByText('Tag created')).toHaveLength(1)
    r1.unmount()

    // Edit: reject -> no toast, then pending -> no toast, then resolve -> exactly one
    const editFail = deferred<unknown>()
    apiMock.PATCH.mockReturnValueOnce(editFail.promise)
    render(
      wrap(
        <TagFormDialog
          tag={{ id: 't1', name: 'kiosk', color: 0x2196f3 }}
          open
          onOpenChange={() => {}}
        />,
      ),
    )
    fireEvent.change(screen.getByLabelText('Tag name'), { target: { value: 'pos' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.queryByText('Tag saved')).toBeNull()
    editFail.reject(new Error('Name taken'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Tag saved')).toBeNull()

    const editOk = deferred<{ id: string; name: string; color: number }>()
    apiMock.PATCH.mockReturnValueOnce(editOk.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(apiMock.PATCH).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Tag saved')).toBeNull()
    editOk.resolve({ id: 't1', name: 'pos', color: 0x2196f3 })
    expect(await screen.findAllByText('Tag saved')).toHaveLength(1)
  })
})
