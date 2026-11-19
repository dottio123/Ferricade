import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { api } from '@/api/client'
import { ToasterProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createQueryClient } from '@/lib/queryClient'
import { createMockDB } from '@/mocks/db'
import { readMockConfig } from '@/mocks/config'
import { createMockApi } from '@/mocks/handlers'
import { ADMIN_ID, HELPDESK_ID } from '@/mocks/fixtures/users'
import { UserMoreActionsMenu, UsersView } from './users-view'
import { UserResetPasswordDialog } from './reset-password-dialog'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

vi.setConfig({ testTimeout: 15_000 })

let closeServer = () => {}
afterEach(() => {
  cleanup()
  closeServer()
})

async function start(search = '') {
  const db = createMockDB('medium')
  const { handlers } = createMockApi(db, readMockConfig(search))
  const posts: unknown[] = []
  const server = setupServer(
    http.post('*/admin/api/v1/users/:id/password', async ({ request }) => {
      posts.push(await request.clone().json())
      return undefined
    }),
    ...handlers,
  )
  server.listen({ onUnhandledRequest: 'error' })
  closeServer = () => server.close()
  await api.GET('/admin/api/v1/auth/me')
  return { db, posts }
}

function wrap(node: React.ReactNode) {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <TooltipProvider>
        <ToasterProvider>{node}</ToasterProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

async function openDialog() {
  const { db, posts } = await start()
  const user = db.users.find((u) => u.id === HELPDESK_ID)!
  const onOpenChange = vi.fn()
  render(wrap(<UserResetPasswordDialog user={user} open onOpenChange={onOpenChange} />))
  return { posts, onOpenChange }
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('Reset password dialog', () => {
  it('names the account, caps the inputs and keeps Save off until every rule is met', async () => {
    await openDialog()
    expect(screen.getByText('Reset password for “helpdesk”')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Sets a new password and signs this account out everywhere. Tell them the new password yourself.',
      ),
    ).toBeInTheDocument()
    const first = screen.getByLabelText('New password')
    expect(first).toHaveAttribute('maxLength', '256')
    expect(first).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText('Confirm new password')).toHaveAttribute('maxLength', '256')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    type('New password', 'short')
    type('Confirm new password', 'short')
    expect(save).toBeDisabled()
    type('New password', 'helpdesk')
    expect(save).toBeDisabled()
    type('New password', 'a-fine-password-1')
    expect(save).toBeDisabled() // does not match the confirmation
    expect(screen.getByText('Passwords match').closest('div')).toHaveTextContent('not met')
    type('Confirm new password', 'a-fine-password-1')
    expect(save).toBeEnabled()
  })

  it('posts exactly {password}, toasts and closes', async () => {
    const { posts, onOpenChange } = await openDialog()
    type('New password', 'a-fine-password-1')
    type('Confirm new password', 'a-fine-password-1')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false), { timeout: 5_000 })
    expect(posts).toEqual([{ password: 'a-fine-password-1' }])
    expect(await screen.findByText('Password reset for helpdesk')).toBeInTheDocument()
  })

  it('marks the common-password rule with the server message and stays open', async () => {
    const { posts, onOpenChange } = await openDialog()
    type('New password', 'password1234')
    type('Confirm new password', 'password1234')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('that password is too common')).toBeInTheDocument()
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Confirm new password')).toHaveAttribute('aria-invalid', 'true')
    expect(posts).toHaveLength(1)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('shows other errors inline', async () => {
    const { posts } = await openDialog()
    closeServer()
    const server = setupServer(
      http.post('*/admin/api/v1/users/:id/password', () =>
        HttpResponse.json(
          { error: { code: 'busy', message: 'try again shortly' } },
          { status: 503 },
        ),
      ),
    )
    server.listen({ onUnhandledRequest: 'error' })
    closeServer = () => server.close()
    type('New password', 'a-fine-password-1')
    type('Confirm new password', 'a-fine-password-1')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('try again shortly')
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('New password')).toHaveAttribute(
      'aria-describedby',
      'user-reset-password-rules user-reset-password-error',
    )
    expect(screen.getByLabelText('Confirm new password')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Confirm new password')).toHaveAttribute(
      'aria-describedby',
      'user-reset-password-rules user-reset-password-error',
    )
    expect(posts).toHaveLength(0)
  })
})

describe('Reset password action on the Users page', () => {
  it('shows on every row except the owner’s own', async () => {
    await start()
    render(wrap(<UsersView />))
    const helpdeskTriggers = await screen.findAllByRole('button', {
      name: 'More actions for helpdesk',
    })
    fireEvent.keyDown(helpdeskTriggers[0]!, { key: 'Enter' })
    expect(await screen.findByRole('menuitem', { name: 'Reset password' })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? helpdeskTriggers[0]!, { key: 'Escape' })

    const samTriggers = screen.getAllByRole('button', { name: 'More actions for sam' })
    fireEvent.keyDown(samTriggers[0]!, { key: 'Enter' })
    expect(await screen.findByRole('menuitem', { name: 'Reset password' })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? samTriggers[0]!, { key: 'Escape' })

    const alexTriggers = screen.getAllByRole('button', { name: 'More actions for alex' })
    fireEvent.keyDown(alexTriggers[0]!, { key: 'Enter' })
    expect(await screen.findByRole('menuitem', { name: 'Reset 2FA' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Reset password' })).toBeNull()
  })

  it('is absent for an admin', async () => {
    const { db } = await start('?mock-role=admin')
    render(wrap(<UsersView />))
    expect(await screen.findByText('No users found')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Reset password' })).toBeNull()

    cleanup()
    const sam = db.users.find((u) => u.id === ADMIN_ID)!
    render(
      wrap(
        <UserMoreActionsMenu
          user={sam}
          isOwner={false}
          isSelf={false}
          onResetTotp={vi.fn()}
          onResetPassword={vi.fn()}
          onUnlinkSso={vi.fn()}
        />,
      ),
    )
    const samTrigger = screen.getByRole('button', { name: 'More actions for sam' })
    fireEvent.keyDown(samTrigger, { key: 'Enter' })
    expect(await screen.findByRole('menuitem', { name: 'Reset 2FA' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Reset password' })).toBeNull()
  })
})
