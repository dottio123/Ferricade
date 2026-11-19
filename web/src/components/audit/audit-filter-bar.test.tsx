import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTION_GROUPS, AuditFilterBar } from './audit-filter-bar'

// Action ids that describe.ts words but the Actions filter deliberately omits.
const NOT_FILTERABLE: Record<string, string> = {
  'group.updated': 'legacy wording; the server no longer records it',
  'user.deleted': 'legacy wording; the server no longer records it',
  'settings.server_updated': 'legacy wording; the server records server.updated',
  'session.started': 'live-event name, not an audit action',
  'session.updated': 'live-event name, not an audit action',
  'session.ended': 'live-event name, not an audit action',
}

describe('audit action filter', () => {
  it('lists every action id that describe.ts words, except the explicit excludes', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/audit/describe.ts'), 'utf8')
    const handled = [...source.matchAll(/case '([a-z_.]+)':/g)].map((m) => m[1] ?? '')
    expect(handled.length).toBeGreaterThan(50)
    const listed = new Set(ACTION_GROUPS.flatMap((g) => g.actions.map((a) => a.id)))
    const missing = handled.filter((id) => !listed.has(id) && !(id in NOT_FILTERABLE))
    expect(missing).toEqual([])
  })

  it('keeps the excludes honest and ids unique', () => {
    const ids = ACTION_GROUPS.flatMap((g) => g.actions.map((a) => a.id))
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of Object.keys(NOT_FILTERABLE)) expect(ids).not.toContain(id)
  })
})

describe('audit action combobox', () => {
  afterEach(cleanup)
  HTMLElement.prototype.scrollIntoView = vi.fn()
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  function setup(action?: string) {
    const onChange = vi.fn()
    render(
      <AuditFilterBar
        filters={{ action }}
        onChange={onChange}
        onReset={() => {}}
        isOwner
        users={[]}
        hideActor
      />,
    )
    return onChange
  }

  it('filters the list by typed text and picks with a click', async () => {
    const onChange = setup()
    const trigger = screen.getByRole('combobox', { name: 'Filter by action' })
    expect(trigger).toHaveTextContent('All actions')
    fireEvent.click(trigger)
    const input = await screen.findByPlaceholderText('Search actions…')
    fireEvent.change(input, { target: { value: 'block' } })
    expect(screen.getByRole('option', { name: 'Blocked RustDesk ID' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Approved device' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Blocked RustDesk ID' }))
    expect(onChange).toHaveBeenCalledWith({ action: 'device.id_blocked' })
  })

  it('picks the top match with Enter', async () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by action' }))
    const input = await screen.findByPlaceholderText('Search actions…')
    fireEvent.change(input, { target: { value: 'device.id_blocked_overflow' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({ action: 'device.id_blocked_overflow' })
  })

  it('also matches the action id and picks by click', async () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by action' }))
    fireEvent.change(await screen.findByPlaceholderText('Search actions…'), {
      target: { value: 'oidc_unlinked' },
    })
    fireEvent.click(screen.getByRole('option', { name: 'Unlinked provider sign-in' }))
    expect(onChange).toHaveBeenCalledWith({ action: 'user.oidc_unlinked' })
  })

  it('clears with All actions, shows the current label, and closes on Escape', async () => {
    const onChange = setup('device.approved')
    const trigger = screen.getByRole('combobox', { name: 'Filter by action' })
    expect(trigger).toHaveTextContent('Approved device')
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('option', { name: 'All actions' }))
    expect(onChange).toHaveBeenCalledWith({ action: undefined })
    fireEvent.click(trigger)
    const input = await screen.findByPlaceholderText('Search actions…')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Search actions…')).not.toBeInTheDocument()
  })

  it('exposes accessible names on the opened popover dialog and search combobox', async () => {
    setup()
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by action' }))
    expect(await screen.findByRole('dialog', { name: 'Filter by action' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Search actions' })).toBeInTheDocument()
  })
})
