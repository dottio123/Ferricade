import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { TotpEnrollment } from './totp-enrollment'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

afterEach(() => vi.clearAllMocks())

describe('TotpEnrollment', () => {
  it('allows the server to verify a passwordless SSO account', async () => {
    const requestSecret = vi.fn().mockResolvedValue({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauth_url: 'otpauth://totp/ferricade:user?secret=JBSWY3DPEHPK3PXP',
    })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <TotpEnrollment requireCurrentPassword requestSecret={requestSecret} />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(requestSecret).toHaveBeenCalledWith(''))
    expect(screen.getByLabelText('Verification code')).toBeTruthy()
  })

  it('requires the current password and shows the server error', async () => {
    const requestSecret = vi
      .fn()
      .mockRejectedValue(new ApiError(403, 'forbidden', 'current password is incorrect'))
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <TotpEnrollment requireCurrentPassword requestSecret={requestSecret} />
      </QueryClientProvider>,
    )

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(requestSecret).toHaveBeenCalledWith('wrong'))
    expect(await screen.findByRole('alert')).toHaveTextContent('current password is incorrect')
  })
})
