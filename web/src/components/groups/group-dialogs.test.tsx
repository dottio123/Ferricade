import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToasterProvider } from '@/components/ui/toast'
import type { components } from '@/api/schema'
import {
  GroupCreateDialog,
  GroupMoveDialog,
  GroupPolicyDialog,
  GroupRenameDialog,
} from './group-dialogs'

const apiMock = vi.hoisted(() => ({
  POST: vi.fn(),
  PATCH: vi.fn(),
  PUT: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: apiMock,
  unwrap: (result: unknown) => result,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const sampleGroup: components['schemas']['Group'] = {
  id: 'g1',
  name: 'Engineering',
  parent_id: null,
  policy_id: null,
  effective_policy_id: 'pol-default',
  children: [],
}

describe('group form errors', () => {
  it('links a failed create error to the name field', async () => {
    apiMock.POST.mockRejectedValueOnce(new Error('Duplicate group'))
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
      >
        <ToasterProvider>
          <GroupCreateDialog open onOpenChange={() => {}} />
        </ToasterProvider>
      </QueryClientProvider>,
    )
    const name = screen.getByLabelText('Group name')
    fireEvent.change(name, { target: { value: 'Engineering' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    const error = await screen.findByRole('alert')
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAttribute('aria-describedby', error.id)
  })
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

describe('group dialog toasts', () => {
  it('shows no toast while pending or rejected, and exactly one after create, rename, move, and policy assign', async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const wrap = (node: React.ReactNode) => (
      <QueryClientProvider client={client}>
        <ToasterProvider>{node}</ToasterProvider>
      </QueryClientProvider>
    )

    // Create: reject -> no toast, pending -> no toast, resolve -> 1 toast
    const createFail = deferred<unknown>()
    apiMock.POST.mockReturnValueOnce(createFail.promise)
    const r1 = render(wrap(<GroupCreateDialog open onOpenChange={() => {}} />))
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Ops' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    expect(screen.queryByText('Group created')).toBeNull()
    createFail.reject(new Error('Failed'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Group created')).toBeNull()

    const createOk = deferred<unknown>()
    apiMock.POST.mockReturnValueOnce(createOk.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    expect(screen.queryByText('Group created')).toBeNull()
    createOk.resolve({ id: 'g2', name: 'Ops' })
    expect(await screen.findAllByText('Group created')).toHaveLength(1)
    r1.unmount()

    // Rename: reject -> no toast, pending -> no toast, resolve -> 1 toast
    const renameFail = deferred<unknown>()
    apiMock.PATCH.mockReturnValueOnce(renameFail.promise)
    const r2 = render(wrap(<GroupRenameDialog group={sampleGroup} open onOpenChange={() => {}} />))
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Platform' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(screen.queryByText('Group saved')).toBeNull()
    renameFail.reject(new Error('Failed'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Group saved')).toBeNull()

    const renameOk = deferred<unknown>()
    apiMock.PATCH.mockReturnValueOnce(renameOk.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(screen.queryByText('Group saved')).toBeNull()
    renameOk.resolve({ ...sampleGroup, name: 'Platform' })
    expect(await screen.findAllByText('Group saved')).toHaveLength(1)
    r2.unmount()

    // Move: reject -> no toast, pending -> no toast, resolve -> 1 toast
    const moveFail = deferred<unknown>()
    apiMock.POST.mockReturnValueOnce(moveFail.promise)
    const r3 = render(
      wrap(
        <GroupMoveDialog group={sampleGroup} tree={[sampleGroup]} open onOpenChange={() => {}} />,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Move group' }))
    expect(screen.queryByText('Group moved')).toBeNull()
    moveFail.reject(new Error('Failed'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Group moved')).toBeNull()

    const moveOk = deferred<unknown>()
    apiMock.POST.mockReturnValueOnce(moveOk.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Move group' }))
    expect(screen.queryByText('Group moved')).toBeNull()
    moveOk.resolve(sampleGroup)
    expect(await screen.findAllByText('Group moved')).toHaveLength(1)
    r3.unmount()

    // Policy: reject -> no toast, pending -> no toast, resolve -> 1 toast
    const policyFail = deferred<unknown>()
    apiMock.PUT.mockReturnValueOnce(policyFail.promise)
    render(
      wrap(<GroupPolicyDialog group={sampleGroup} policies={[]} open onOpenChange={() => {}} />),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }))
    expect(screen.queryByText('Group policy saved')).toBeNull()
    policyFail.reject(new Error('Failed'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Group policy saved')).toBeNull()

    const policyOk = deferred<unknown>()
    apiMock.PUT.mockReturnValueOnce(policyOk.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }))
    expect(screen.queryByText('Group policy saved')).toBeNull()
    policyOk.resolve(sampleGroup)
    expect(await screen.findAllByText('Group policy saved')).toHaveLength(1)
  })
})
