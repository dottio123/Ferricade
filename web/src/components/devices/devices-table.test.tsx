import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DevicesTable, type Device } from './devices-table'

vi.mock('@/features/dashboard/use-preferences', () => ({
  useRawPreferences: () => ({ data: undefined }),
  useUpdatePreferences: () => ({ togglePin: vi.fn() }),
}))
vi.mock('./device-link', () => ({
  DeviceLink: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}))

afterEach(cleanup)

describe.each([false, true])('DevicesTable mobile=%s', (mobile) => {
  it('shows the primary user and a dash when it is empty', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    const common: Device = {
      id: '',
      rustdesk_id: '',
      uuid: '',
      state: 'approved',
      alias: '',
      hostname: '',
      os: '',
      cpu: '',
      memory: '',
      client_version: '',
      username: '',
      note: '',
      group_id: null,
      first_seen_at: '',
      last_seen_at: '',
      approved_by: null,
      approved_at: null,
      updated_at: '',
      tags: [],
      open_alerts: [],
      online: true,
      conns: [],
    }
    const devices: Device[] = [
      {
        ...common,
        id: '1',
        alias: 'Office',
        hostname: 'office-pc',
        username: 'alice',
        state: 'approved',
        tags: [],
        online: true,
      },
      {
        ...common,
        id: '2',
        alias: 'Lab',
        hostname: 'lab-pc',
        username: '',
        state: 'approved',
        tags: [],
        online: true,
      },
    ]
    render(
      <TooltipProvider>
        <DevicesTable
          devices={devices}
          selectedIds={new Set()}
          onToggleSelect={() => {}}
          onToggleSelectAll={() => {}}
          groupsMap={new Map()}
        />
      </TooltipProvider>,
    )
    expect(screen.getByText('User: alice')).toBeTruthy()
    expect(screen.getByText('User: —')).toBeTruthy()
    vi.unstubAllGlobals()
  })
})
