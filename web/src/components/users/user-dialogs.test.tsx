import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createQueryClient } from '@/lib/queryClient'
import type { User } from '@/features/audit/actor'
import { ToasterProvider } from '@/components/ui/toast'
import { UserCreateDialog, UserEditDialog, removesGrants } from './user-dialogs'

const apiMock = vi.hoisted(() => ({
  POST: vi.fn(),
  PATCH: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: apiMock,
  unwrap: (result: unknown) => result,
}))

// jsdom lacks what Radix Select calls when it opens.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
})
afterEach(cleanup)

const WARNING = 'Changing this role removes the devices and groups assigned to this account.'
const DESCRIPTION = 'Sees and connects to the devices you assign'

const user = (role: User['role']): User => ({
  id: 'u1',
  username: 'pat',
  display_name: '',
  email: '',
  role,
  status: 'active',
  totp_required: false,
  sso: false,
  avatar_url: null,
})

function wrap(node: React.ReactNode) {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <ToasterProvider>{node}</ToasterProvider>
    </QueryClientProvider>
  )
}

const role = () => screen.getByRole('combobox', { name: 'Role' })

async function pick(trigger: HTMLElement, name: string) {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${name}`) }))
}

describe('removesGrants', () => {
  it('is true for each role change to or from user, and only then', () => {
    expect(removesGrants('user', 'owner')).toBe(true)
    expect(removesGrants('user', 'admin')).toBe(true)
    expect(removesGrants('owner', 'user')).toBe(true)
    expect(removesGrants('admin', 'user')).toBe(true)
    expect(removesGrants('user', 'user')).toBe(false)
    expect(removesGrants('admin', 'owner')).toBe(false)
    expect(removesGrants('owner', 'admin')).toBe(false)
  })
})

describe('role picker', () => {
  it('create dialog offers User with its description', async () => {
    render(wrap(<UserCreateDialog open onOpenChange={() => {}} />))
    expect(screen.getByLabelText('Password')).toHaveAttribute('maxLength', '256')
    await pick(role(), 'User')
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument()
  })

  it('edit dialog warns for each change to or from User and not otherwise', async () => {
    const view = render(wrap(<UserEditDialog user={user('admin')} open onOpenChange={() => {}} />))
    expect(screen.queryByText(WARNING)).toBeNull()
    await pick(role(), 'Owner')
    expect(screen.queryByText(WARNING)).toBeNull()
    await pick(role(), 'User')
    expect(screen.getByText(WARNING)).toBeInTheDocument()
    await pick(role(), 'Admin')
    expect(screen.queryByText(WARNING)).toBeNull()
    view.unmount()

    render(wrap(<UserEditDialog user={user('user')} open onOpenChange={vi.fn()} />))
    expect(screen.queryByText(WARNING)).toBeNull()
    await pick(role(), 'Admin')
    expect(screen.getByText(WARNING)).toBeInTheDocument()
    await pick(role(), 'Owner')
    expect(screen.getByText(WARNING)).toBeInTheDocument()
    await pick(role(), 'User')
    expect(screen.queryByText(WARNING)).toBeNull()
  })

  it('requires self-demotion confirmation when an owner changes their own role to admin or user', async () => {
    const owner = user('owner')
    render(
      wrap(<UserEditDialog user={owner} currentUserId={owner.id} open onOpenChange={() => {}} />),
    )

    await pick(role(), 'User')
    expect(screen.getByText('Warning: modifying your own account')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Removing your owner role will immediately demote your account to user privileges.',
      ),
    ).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Save changes' })
    expect(save).toBeDisabled()

    await pick(role(), 'Admin')
    expect(
      screen.getByText(
        'Removing your owner role will immediately demote your account to admin privileges.',
      ),
    ).toBeInTheDocument()
    expect(save).toBeDisabled()

    fireEvent.click(screen.getByLabelText('I understand and wish to proceed'))
    expect(save).toBeEnabled()
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

describe('user dialog toasts', () => {
  it('shows no toast while pending or rejected, and exactly one after create/edit succeeds', async () => {
    const createFail = deferred<unknown>()
    apiMock.POST.mockReturnValueOnce(createFail.promise)
    const r1 = render(wrap(<UserCreateDialog open onOpenChange={() => {}} />))
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alex' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'StrongPass123!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }))
    expect(screen.queryByText('User created')).toBeNull()
    createFail.reject(new Error('Username taken'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('User created')).toBeNull()

    const createOk = deferred<unknown>()
    apiMock.POST.mockReturnValueOnce(createOk.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }))
    expect(screen.queryByText('User created')).toBeNull()
    createOk.resolve({ id: 'u2', username: 'alex' })
    expect(await screen.findAllByText('User created')).toHaveLength(1)
    r1.unmount()

    const editFail = deferred<unknown>()
    apiMock.PATCH.mockReturnValueOnce(editFail.promise)
    render(wrap(<UserEditDialog user={user('admin')} open onOpenChange={() => {}} />))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Pat' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.queryByText('User saved')).toBeNull()
    editFail.reject(new Error('Update failed'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('User saved')).toBeNull()

    const editOk = deferred<unknown>()
    apiMock.PATCH.mockReturnValueOnce(editOk.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.queryByText('User saved')).toBeNull()
    editOk.resolve(user('admin'))
    expect(await screen.findAllByText('User saved')).toHaveLength(1)
  })
})
