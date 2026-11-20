import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from '@/api/errors'
import { ToasterProvider } from '@/components/ui/toast'
import { MutationErrorToasts } from './mutation-error-toasts'

async function fail(error: unknown, meta?: { errorTitle?: string }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ToasterProvider>
        <MutationErrorToasts />
      </ToasterProvider>
    </QueryClientProvider>,
  )
  const mutation = client.getMutationCache().build(client, {
    mutationFn: () => Promise.reject(error),
    meta,
  })
  await act(() => mutation.execute(undefined).catch(() => undefined))
}

afterEach(cleanup)

describe('MutationErrorToasts', () => {
  it('toasts a failure of a mutation that has an errorTitle', async () => {
    await fail(new ApiError(500, 'internal', 'boom'), {
      errorTitle: 'Could not approve the device',
    })
    expect(screen.getByText('Could not approve the device')).toBeTruthy()
  })

  it('stays quiet without an errorTitle (the form shows its own error)', async () => {
    await fail(new ApiError(500, 'internal', 'boom'))
    expect(screen.queryByText(/Could not/)).toBeNull()
  })

  // These already send the user to sign-in or the second-factor step.
  it.each([
    [401, 'unauthenticated'],
    [403, 'csrf'],
    [403, 'mfa_required'],
    [403, 'totp_enroll_required'],
  ] as const)('stays quiet for %i %s', async (status, code) => {
    await fail(new ApiError(status, code, 'x'), { errorTitle: 'Could not approve the device' })
    expect(screen.queryByText('Could not approve the device')).toBeNull()
  })

  it('still toasts a 403 forbidden (a role the user does not have)', async () => {
    await fail(new ApiError(403, 'forbidden', 'owners only'), { errorTitle: 'Could not save' })
    expect(screen.getByText('Could not save')).toBeTruthy()
  })
})
