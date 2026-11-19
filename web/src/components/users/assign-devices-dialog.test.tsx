import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { api } from '@/api/client'
import type { components } from '@/api/schema'
import { ToasterProvider } from '@/components/ui/toast'
import { createQueryClient } from '@/lib/queryClient'
import { createMockDB } from '@/mocks/db'
import { readMockConfig } from '@/mocks/config'
import { createMockApi } from '@/mocks/handlers'
import { HELPDESK_ID } from '@/mocks/fixtures/users'
import { AssignDevicesDialog, coveredGroupIds, grantsBody } from './assign-devices-dialog'

vi.setConfig({ testTimeout: 15_000 })

type Grants = components['schemas']['UserGrants']
type Group = components['schemas']['Group']

let closeServer = () => {}
afterEach(() => {
  cleanup()
  closeServer()
})

const g = (id: string, children: Group[] = []): Group => ({
  id,
  parent_id: null,
  name: id,
  policy_id: null,
  effective_policy_id: '00000000-0000-4000-8000-000000000001',
  children,
})

describe('grant helpers', () => {
  it('covers the subtree of every checked group, not the group itself', () => {
    const tree = [g('a', [g('b', [g('c')]), g('d')]), g('e', [g('f')])]
    expect([...coveredGroupIds(tree, new Set(['a']))].sort()).toEqual(['b', 'c', 'd'])
    expect([...coveredGroupIds(tree, new Set(['b', 'e']))].sort()).toEqual(['c', 'f'])
    expect(coveredGroupIds(tree, new Set()).size).toBe(0)
  })
  it('builds the body from the checked ids only', () => {
    expect(grantsBody([g('a', [g('b')])], new Set(['a', 'x']), new Set(['d1']))).toEqual({
      group_ids: ['a', 'x'],
      device_ids: ['d1'],
    })
  })
})

async function setup(failure?: { status: number; body: unknown }) {
  const db = createMockDB('medium')
  const { handlers } = createMockApi(db, readMockConfig(''))
  const puts: Grants[] = []
  const server = setupServer(
    http.put('*/admin/api/v1/users/:id/grants', async ({ request }) => {
      puts.push((await request.clone().json()) as Grants)
      if (failure) return HttpResponse.json(failure.body as object, { status: failure.status })
      return undefined
    }),
    ...handlers,
  )
  server.listen({ onUnhandledRequest: 'error' })
  closeServer = () => server.close()
  // The session's CSRF token comes from GET /auth/me, as in the app.
  await api.GET('/admin/api/v1/auth/me')
  const user = db.users.find((u) => u.id === HELPDESK_ID)!
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ToasterProvider>
        <AssignDevicesDialog user={user} open onOpenChange={onOpenChange} />
      </ToasterProvider>
    </QueryClientProvider>,
  )
  return { db, puts, onOpenChange }
}

describe('Assign devices dialog', () => {
  it('shows the saved grants, covers subgroups of a checked group and sends only the checked ids', async () => {
    const { db, puts, onOpenChange } = await setup()
    const office = db.groups.find((x) => x.name === 'Office')!
    const home = db.groups.find((x) => x.name === 'Home lab')!
    const officeBox = await screen.findByRole('checkbox', { name: 'Office' })
    await waitFor(() => expect(officeBox).toBeChecked())
    const reception = screen.getByRole('checkbox', { name: 'Reception' })
    expect(reception).toBeChecked()
    expect(reception).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Home lab' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5_000 })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false), { timeout: 5_000 })
    expect(puts).toHaveLength(1)
    expect([...puts[0]!.group_ids].sort()).toEqual([office.id, home.id].sort())
    expect(puts[0]!.device_ids).toEqual(db.grantsFor(HELPDESK_ID).device_ids)
    expect(await screen.findByText('Assigned devices saved')).toBeInTheDocument()
  })

  it('collapses subgroups, but starts expanded where a group holds a checked or covered one', async () => {
    const { db } = await setup()
    const office = db.groups.find((x) => x.name === 'Office')!
    // The saved grant is Office, so its subgroups are covered and visible at once.
    expect(await screen.findByRole('checkbox', { name: 'Reception' })).toBeInTheDocument()
    const collapse = screen.getByRole('button', { name: 'Collapse Office' })
    expect(collapse).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(collapse)
    expect(screen.queryByRole('checkbox', { name: 'Reception' })).not.toBeInTheDocument()
    // A collapsed group keeps its checked state.
    expect(screen.getByRole('checkbox', { name: office.name })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Expand Office' }))
    expect(screen.getByRole('checkbox', { name: 'Reception' })).toBeDisabled()
  })

  it('checks a device from the searchable list and sends it', async () => {
    const { db, puts } = await setup()
    const device = db.deviceRows.find(
      (d) => d.state === 'approved' && !db.grantsFor(HELPDESK_ID).device_ids.includes(d.id),
    )!
    const search = await screen.findByRole('searchbox', { name: 'Search devices' })
    fireEvent.change(search, { target: { value: device.hostname } })
    const box = await screen.findByRole('checkbox', {
      name: new RegExp(`^${device.hostname}.*${device.rustdesk_id}$`),
    })
    expect(box).not.toBeChecked()
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]!.device_ids).toContain(device.id)
  })

  it('excludes a selected subgroup when its parent becomes checked', async () => {
    const { db, puts } = await setup()
    const office = db.groups.find((x) => x.name === 'Office')!
    const reception = db.groups.find((x) => x.name === 'Reception')!
    const officeBox = await screen.findByRole('checkbox', { name: 'Office' })
    fireEvent.click(officeBox)
    const receptionBox = screen.getByRole('checkbox', { name: 'Reception' })
    fireEvent.click(receptionBox)
    fireEvent.click(officeBox)
    expect(receptionBox).toBeChecked()
    expect(receptionBox).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]!.group_ids).toContain(office.id)
    expect(puts[0]!.group_ids).not.toContain(reception.id)
  })

  it('shows selected counts even when search hides a selection, plus device alias and group name', async () => {
    const { db } = await setup()
    const grouped =
      db.deviceRows.find((d) => d.state === 'approved' && d.group_id !== null && d.alias) ??
      db.deviceRows.find((d) => d.state === 'approved' && d.group_id !== null)!
    const groupName = db.groups.find((gr) => gr.id === grouped.group_id)!.name
    const initialDeviceCount = db.grantsFor(HELPDESK_ID).device_ids.length
    expect(await screen.findByRole('heading', { name: 'Groups, 1 selected' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: `Devices, ${initialDeviceCount} selected` }),
    ).toBeInTheDocument()

    // Check the grouped device, then search for something that hides it.
    const groupedBox = await screen.findByRole('checkbox', {
      name: new RegExp(`${grouped.hostname}.*${grouped.rustdesk_id}`),
    })
    const row = groupedBox.closest('li')!
    expect(within(row).getByText(groupName)).toBeInTheDocument()
    if (grouped.alias) {
      expect(within(row).getByText(grouped.alias)).toBeInTheDocument()
    }
    const wasChecked = (groupedBox as HTMLInputElement).checked
    fireEvent.click(groupedBox)
    const expectedAfterToggle = wasChecked ? initialDeviceCount - 1 : initialDeviceCount + 1
    expect(
      screen.getByRole('heading', { name: `Devices, ${expectedAfterToggle} selected` }),
    ).toBeInTheDocument()

    const search = screen.getByRole('searchbox', { name: 'Search devices' })
    fireEvent.change(search, { target: { value: 'zzzz-no-match' } })
    await screen.findByText('No approved devices match.')
    expect(
      screen.getByRole('heading', { name: `Devices, ${expectedAfterToggle} selected` }),
    ).toBeInTheDocument()
  })

  it('shows no group label and no error when a device group_id is not in the loaded groups', async () => {
    const db = createMockDB('medium')
    const orphan = db.deviceRows.find((d) => d.state === 'approved')!
    orphan.group_id = '00000000-0000-4000-8000-999999999999'
    const { handlers } = createMockApi(db, readMockConfig(''))
    const server = setupServer(...handlers)
    server.listen({ onUnhandledRequest: 'error' })
    closeServer = () => server.close()
    await api.GET('/admin/api/v1/auth/me')
    const user = db.users.find((u) => u.id === HELPDESK_ID)!
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ToasterProvider>
          <AssignDevicesDialog user={user} open onOpenChange={() => {}} />
        </ToasterProvider>
      </QueryClientProvider>,
    )

    const box = await screen.findByRole('checkbox', {
      name: new RegExp(`${orphan.hostname}.*${orphan.rustdesk_id}`),
    })
    const label = box.closest('label')!
    expect(label.querySelector('[data-slot="device-group"]')).toBeNull()
    expect(label.textContent).not.toContain(orphan.group_id)
    expect(label.textContent).not.toContain('undefined')
    expect(label.textContent).not.toContain('Office')
    expect(label.textContent).not.toContain('Home lab')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    [400, 'bad_request', 'unknown group'],
    [409, 'bad_transition', 'grants apply to the user role only'],
  ])('shows the server message for %i and stays open', async (status, code, message) => {
    const { onOpenChange } = await setup({ status, body: { error: { code, message } } })
    await screen.findByRole('checkbox', { name: 'Office' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(new RegExp(message))).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
