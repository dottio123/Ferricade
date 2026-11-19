import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AccountSettingsView } from './account-settings-view'

const session = vi.hoisted(() => ({ displayName: 'Alex' }))
vi.mock('@/auth/session', () => ({
  useMe: () => ({
    data: { user: { username: 'alex', role: 'owner', display_name: session.displayName } },
  }),
}))
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@/components/account/account-nav-tabs', () => ({ AccountNavTabs: () => null }))

describe('account password form', () => {
  it('uses the display name in the header and falls back to username', () => {
    const queryClient = new QueryClient()
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AccountSettingsView />
      </QueryClientProvider>,
    )
    expect(
      screen.getByText('Manage authentication credentials and two-factor security for Alex.'),
    ).toBeInTheDocument()
    session.displayName = ''
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <AccountSettingsView />
      </QueryClientProvider>,
    )
    expect(
      screen.getByText('Manage authentication credentials and two-factor security for alex.'),
    ).toBeInTheDocument()
    session.displayName = 'Alex'
    view.unmount()
  })
  it('describes new password rules with text state and field association', () => {
    const queryClient = new QueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <AccountSettingsView />
      </QueryClientProvider>,
    )
    const password = screen.getByLabelText('New password')
    expect(password).toHaveAttribute('maxLength', '256')
    expect(screen.getByLabelText('Confirm new password')).toHaveAttribute('maxLength', '256')
    expect(password).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining('account-password-rules'),
    )
    expect(screen.getByText(/At least 12 characters/).parentElement).toHaveTextContent('not met')
    fireEvent.change(password, { target: { value: 'very-long-password' } })
    expect(screen.getByText(/At least 12 characters/).parentElement).toHaveTextContent('met')
  })
})
