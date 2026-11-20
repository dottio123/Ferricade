import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import { Sheet, SheetClose, SheetContent, SheetTitle } from './sheet'

describe.each(['dialog', 'sheet'] as const)('%s focus', (kind) => {
  it('returns focus to the opener without a Radix trigger', async () => {
    function Fixture() {
      const [open, setOpen] = React.useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>Open overlay</button>
          {kind === 'dialog' ? (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent>
                <DialogTitle>Overlay</DialogTitle>
              </DialogContent>
            </Dialog>
          ) : (
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetContent>
                <SheetTitle>Overlay</SheetTitle>
              </SheetContent>
            </Sheet>
          )}
        </>
      )
    }
    const view = render(<Fixture />)
    const opener = screen.getByRole('button', { name: 'Open overlay' })
    opener.focus()
    fireEvent.click(opener)
    await screen.findByRole('dialog')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(opener).toHaveFocus())
    view.unmount()
  })
})

it('returns focus when dialog content overrides its data-slot', async () => {
  function Fixture() {
    const [open, setOpen] = React.useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>Open group</button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent data-slot="group-create-dialog">
            <DialogTitle>Create group</DialogTitle>
            <input aria-label="Group name" autoFocus />
          </DialogContent>
        </Dialog>
      </>
    )
  }
  const view = render(<Fixture />)
  const opener = screen.getByRole('button', { name: 'Open group' })
  opener.focus()
  fireEvent.click(opener)
  const name = await screen.findByRole('textbox', { name: 'Group name' })
  expect(screen.getByRole('dialog')).toHaveAttribute('data-overlay-content')
  await waitFor(() => expect(name).toHaveFocus())
  fireEvent.keyDown(name, { key: 'Escape' })
  await waitFor(() => expect(opener).toHaveFocus())
  view.unmount()
})

it('ignores a close request for an outer overlay while a nested one is open', async () => {
  const outerChange = vi.fn()
  function Fixture() {
    const [outer, setOuter] = React.useState(true)
    const [inner, setInner] = React.useState(false)
    return (
      <Sheet
        open={outer}
        onOpenChange={(open) => {
          outerChange(open)
          setOuter(open)
        }}
      >
        <SheetContent showCloseButton={false}>
          <SheetTitle>Outer</SheetTitle>
          <SheetClose>Close outer</SheetClose>
          <button onClick={() => setInner(true)}>Open inner</button>
          <Dialog open={inner} onOpenChange={setInner}>
            <DialogContent>
              <DialogTitle>Inner</DialogTitle>
            </DialogContent>
          </Dialog>
        </SheetContent>
      </Sheet>
    )
  }
  const view = render(<Fixture />)
  fireEvent.click(screen.getByRole('button', { name: 'Open inner' }))
  await screen.findByText('Inner')
  // What Radix does when its Escape handler for the outer layer ran against a
  // stale "I am the top layer" render: it asks the outer overlay to close.
  fireEvent.click(screen.getByRole('button', { name: 'Close outer', hidden: true }))
  expect(outerChange).not.toHaveBeenCalled()
  expect(screen.getByText('Outer')).toBeInTheDocument()
  view.unmount()
})
