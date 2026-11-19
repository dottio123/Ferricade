import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { GroupCheckTree, GroupPicker, groupPaths } from './group-tree-picker'
import type { Group } from './group-utils'

afterEach(cleanup)

const g = (id: string, children: Group[] = []): Group => ({
  id,
  parent_id: null,
  name: id,
  policy_id: null,
  effective_policy_id: '00000000-0000-4000-8000-000000000001',
  children,
})

// Test 1 > Sub1 > Deep; Test 2
const tree = [g('Test 1', [g('Sub1', [g('Deep')])]), g('Test 2')]

describe('groupPaths', () => {
  it('maps every group to its path from the root', () => {
    const paths = groupPaths(tree)
    expect(paths.get('Test 1')).toBe('Test 1')
    expect(paths.get('Sub1')).toBe('Test 1 / Sub1')
    expect(paths.get('Deep')).toBe('Test 1 / Sub1 / Deep')
  })
})

describe('GroupCheckTree', () => {
  const noop = () => {}
  it('starts collapsed and shows only the roots', () => {
    render(
      <GroupCheckTree
        groups={tree}
        checkedIds={new Set()}
        coveredIds={new Set()}
        onToggle={noop}
      />,
    )
    expect(screen.getByRole('checkbox', { name: 'Test 1' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Test 2' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Sub1' })).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Expand Test 1' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /Test 2/ })).not.toBeInTheDocument()
  })

  it('expands and collapses a group, indenting subgroups', () => {
    render(
      <GroupCheckTree
        groups={tree}
        checkedIds={new Set()}
        coveredIds={new Set()}
        onToggle={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand Test 1' }))
    const collapse = screen.getByRole('button', { name: 'Collapse Test 1' })
    expect(collapse).toHaveAttribute('aria-expanded', 'true')
    const rootPad = parseFloat(
      screen.getByRole('checkbox', { name: 'Test 1' }).closest('li')!.style.paddingLeft,
    )
    const subPad = parseFloat(
      screen.getByRole('checkbox', { name: 'Sub1' }).closest('li')!.style.paddingLeft,
    )
    expect(subPad).toBeGreaterThan(rootPad)
    // Sub1 is still collapsed.
    expect(screen.queryByRole('checkbox', { name: 'Deep' })).not.toBeInTheDocument()
    fireEvent.click(collapse)
    expect(screen.queryByRole('checkbox', { name: 'Sub1' })).not.toBeInTheDocument()
  })

  it('starts expanded along the path to a checked group', () => {
    render(
      <GroupCheckTree
        groups={tree}
        checkedIds={new Set(['Deep'])}
        coveredIds={new Set()}
        onToggle={noop}
      />,
    )
    expect(screen.getByRole('checkbox', { name: 'Deep' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Collapse Test 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse Sub1' })).toBeInTheDocument()
  })

  it('starts expanded where a group is covered by a checked parent', () => {
    render(
      <GroupCheckTree
        groups={tree}
        checkedIds={new Set(['Test 1'])}
        coveredIds={new Set(['Sub1', 'Deep'])}
        onToggle={noop}
      />,
    )
    const sub = screen.getByRole('checkbox', { name: 'Sub1' })
    expect(sub).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Deep' })).toBeDisabled()
    const noteId = sub.getAttribute('aria-describedby')
    expect(noteId).toBeTruthy()
    const note = document.getElementById(noteId!)
    expect(note).toHaveTextContent('covered by a parent group')
    expect(note?.parentElement).toBe(sub.closest('label')?.parentElement)
  })

  it('reports toggles', () => {
    const onToggle = vi.fn()
    render(
      <GroupCheckTree
        groups={tree}
        checkedIds={new Set()}
        coveredIds={new Set()}
        onToggle={onToggle}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Test 2' }))
    expect(onToggle).toHaveBeenCalledWith('Test 2', true)
  })
})

function open(props: Partial<React.ComponentProps<typeof GroupPicker>> = {}) {
  const onChange = vi.fn()
  render(
    <GroupPicker
      groups={tree}
      value={null}
      onChange={onChange}
      noneLabel="No group"
      ariaLabel="Group"
      {...props}
    />,
  )
  const trigger = screen.getByRole('button', { name: 'Group' })
  trigger.focus()
  fireEvent.click(trigger)
  return { onChange, trigger }
}

describe('GroupPicker', () => {
  it('shows the selected group by its full path on the trigger', () => {
    render(
      <GroupPicker
        groups={tree}
        value="Sub1"
        onChange={() => {}}
        noneLabel="No group"
        ariaLabel="Group"
      />,
    )
    expect(screen.getByRole('button', { name: 'Group' })).toHaveTextContent('Test 1 / Sub1')
  })

  it('shows the none label when nothing is selected', () => {
    render(
      <GroupPicker
        groups={tree}
        value={null}
        onChange={() => {}}
        noneLabel="All groups"
        ariaLabel="Group"
      />,
    )
    expect(screen.getByRole('button', { name: 'Group' })).toHaveTextContent('All groups')
  })

  it('adds the optional ungrouped row after the empty choice and selects its value', async () => {
    const { onChange } = open({ ungroupedOption: 'Ungrouped', ungroupedValue: 'ungrouped' })
    const items = await screen.findAllByRole('treeitem')
    expect(items.map((i) => i.getAttribute('aria-label')).slice(0, 2)).toEqual([
      'No group',
      'Ungrouped',
    ])
    fireEvent.click(items[1]!)
    expect(onChange).toHaveBeenCalledWith('ungrouped')
  })

  it('does not show the ungrouped row without the optional prop', async () => {
    open()
    const items = await screen.findAllByRole('treeitem')
    expect(items.map((i) => i.getAttribute('aria-label'))).not.toContain('Ungrouped')
  })

  it('opens fully expanded: none first, then the tree in order, indented', async () => {
    open()
    const items = await screen.findAllByRole('treeitem')
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual([
      'No group',
      'Test 1',
      'Sub1',
      'Deep',
      'Test 2',
    ])
    expect(items.map((i) => i.getAttribute('aria-level'))).toEqual(['1', '1', '2', '3', '1'])
    const pad = (i: number) => parseFloat(items[i]!.style.paddingLeft)
    expect(pad(2)).toBeGreaterThan(pad(1))
    expect(pad(3)).toBeGreaterThan(pad(2))
  })

  it('collapses and expands a group', async () => {
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse Test 1' }))
    expect(screen.queryByRole('treeitem', { name: 'Sub1' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand Test 1' }))
    expect(screen.getByRole('treeitem', { name: 'Sub1' })).toBeInTheDocument()
  })

  it('marks the selected group and selects another by click, closing the popover', async () => {
    const { onChange } = open({ value: 'Sub1' })
    const sub = await screen.findByRole('treeitem', { name: 'Sub1' })
    expect(sub).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('treeitem', { name: 'Test 2' }))
    expect(onChange).toHaveBeenCalledWith('Test 2')
    expect(screen.queryByRole('tree')).not.toBeInTheDocument()
  })

  it('selects the none row with null', async () => {
    const { onChange } = open({ value: 'Test 2' })
    fireEvent.click(await screen.findByRole('treeitem', { name: 'No group' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('searches by name and shows each match with its path', async () => {
    open()
    const search = await screen.findByRole('combobox', { name: 'Search groups' })
    fireEvent.change(search, { target: { value: 'sub' } })
    const items = screen.getAllByRole('treeitem')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent('Test 1 / Sub1')
    expect(within(items[0]!).queryByRole('button')).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.queryByRole('treeitem')).not.toBeInTheDocument()
    expect(screen.getByText('No groups match.')).toBeInTheDocument()
  })

  it('shows the hint under the search box', async () => {
    open({ hint: 'Shows devices in this group only, not its subgroups.' })
    expect(
      await screen.findByText('Shows devices in this group only, not its subgroups.'),
    ).toBeInTheDocument()
  })

  it('moves with the arrow keys, expands and collapses with Right and Left, selects with Enter', async () => {
    const { onChange } = open()
    const search = await screen.findByRole('combobox', { name: 'Search groups' })
    const active = () =>
      document
        .getElementById(search.getAttribute('aria-activedescendant') ?? '')
        ?.getAttribute('aria-label')
    // The selected row (none) is active first.
    expect(active()).toBe('No group')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(active()).toBe('Test 1')
    fireEvent.keyDown(search, { key: 'ArrowLeft' })
    expect(screen.queryByRole('treeitem', { name: 'Sub1' })).not.toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(active()).toBe('Test 2')
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    fireEvent.keyDown(search, { key: 'ArrowRight' })
    expect(screen.getByRole('treeitem', { name: 'Sub1' })).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(active()).toBe('Sub1')
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('Sub1')
  })

  it('Left on a subgroup moves to its parent', async () => {
    open()
    const search = await screen.findByRole('combobox', { name: 'Search groups' })
    for (let i = 0; i < 3; i++) fireEvent.keyDown(search, { key: 'ArrowDown' })
    // Deep has no subgroups, so Left goes to its parent, Sub1.
    fireEvent.keyDown(search, { key: 'ArrowLeft' })
    const id = search.getAttribute('aria-activedescendant') ?? ''
    expect(document.getElementById(id)).toHaveAttribute('aria-label', 'Sub1')
  })

  it('Escape closes the popover and returns focus to the trigger', async () => {
    const { trigger } = open()
    const search = await screen.findByRole('combobox', { name: 'Search groups' })
    expect(search).toHaveFocus()
    fireEvent.keyDown(search, { key: 'Escape' })
    await vi.waitFor(() => expect(screen.queryByRole('tree')).not.toBeInTheDocument())
    await vi.waitFor(() => expect(trigger).toHaveFocus())
  })
})
