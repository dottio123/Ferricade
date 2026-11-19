import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { components } from '@/api/schema'
import { ToasterProvider } from '@/components/ui/toast'
import { useRejectDevices } from './use-reject-devices'

afterEach(cleanup)

describe('useRejectDevices', () => {
  it('shows a named undo action for a successful rejection', () => {
    const client = new QueryClient()
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>
        <ToasterProvider>{children}</ToasterProvider>
      </QueryClientProvider>
    )
    const { result } = renderHook(() => useRejectDevices(), { wrapper })
    const device = {
      id: 'device-1',
      alias: 'Reception',
      hostname: 'desk-1',
      rustdesk_id: '123456789',
    } as components['schemas']['Device']

    act(() => result.current.showUndo([device]))

    expect(screen.getByText('Device rejected')).toBeTruthy()
    expect(screen.getByText('Reception')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })
})
