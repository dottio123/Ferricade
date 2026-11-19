import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToasterProvider, useToast } from './toast'

function TestTrigger({ title }: { title: string }) {
  const { toast } = useToast()
  return (
    <button type="button" onClick={() => toast({ title })}>
      Show Toast
    </button>
  )
}

function DurationTrigger({ title, seconds }: { title: string; seconds: number }) {
  const { toast, setDurationSeconds } = useToast()
  return (
    <button
      type="button"
      onClick={() => {
        setDurationSeconds(seconds)
        toast({ title })
      }}
    >
      Show {title}
    </button>
  )
}

function ChangeableDurationTrigger() {
  const { toast, setDurationSeconds } = useToast()
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setDurationSeconds(10)
          toast({ title: 'Changing duration toast' })
        }}
      >
        Show changing duration toast
      </button>
      <button type="button" onClick={() => setDurationSeconds(0)}>
        Keep notifications open
      </button>
    </div>
  )
}

describe('Toast suppression in kiosk mode', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders a toast when kiosk mode is off', async () => {
    render(
      <ToasterProvider kioskSuppressed={false}>
        <TestTrigger title="Hello normal toast" />
      </ToasterProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }))
    await waitFor(() => {
      expect(screen.getByText('Hello normal toast')).toBeInTheDocument()
    })
  })

  it('renders nothing when kiosk mode is on via prop', async () => {
    render(
      <ToasterProvider kioskSuppressed={true}>
        <TestTrigger title="Should be suppressed" />
      </ToasterProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }))
    })
    expect(screen.queryByText('Should be suppressed')).toBeNull()
  })

  it('suppresses toasts when setKioskSuppressed is called from context', async () => {
    function ToggleTrigger() {
      const { toast, setKioskSuppressed } = useToast()
      return (
        <div>
          <button type="button" onClick={() => setKioskSuppressed(true)}>
            Enable Suppression
          </button>
          <button type="button" onClick={() => toast({ title: 'Context suppressed' })}>
            Trigger Toast
          </button>
        </div>
      )
    }

    render(
      <ToasterProvider>
        <ToggleTrigger />
      </ToasterProvider>,
    )

    screen.getByRole('button', { name: 'Enable Suppression' }).click()
    screen.getByRole('button', { name: 'Trigger Toast' }).click()
    expect(screen.queryByText('Context suppressed')).toBeNull()
  })

  it('closes automatically after five seconds and the removal animation', async () => {
    vi.useFakeTimers()
    render(
      <ToasterProvider>
        <TestTrigger title="Timed toast" />
      </ToasterProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }))
    })
    expect(screen.getByText('Timed toast')).toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(4900)
    })
    expect(screen.getByText('Timed toast')).toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(screen.queryByText('Timed toast')).toBeNull()
  })

  it('uses a 10 second duration and keeps duration 0 until closed', async () => {
    vi.useFakeTimers()
    render(
      <ToasterProvider>
        <DurationTrigger title="Ten second toast" seconds={10} />
        <DurationTrigger title="Persistent toast" seconds={0} />
      </ToasterProvider>,
    )

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Show Ten second toast' })),
    )
    await act(async () => vi.advanceTimersByTime(9_999))
    expect(screen.getByText('Ten second toast')).toBeInTheDocument()
    await act(async () => vi.advanceTimersByTime(501))
    expect(screen.queryByText('Ten second toast')).toBeNull()

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Show Persistent toast' })),
    )
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(screen.getByText('Persistent toast')).toBeInTheDocument()
  })

  it('keeps a duration 0 toast open after the pointer leaves', async () => {
    vi.useFakeTimers()
    render(
      <ToasterProvider>
        <DurationTrigger title="Pointer persistent toast" seconds={0} />
      </ToasterProvider>,
    )
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Show Pointer persistent toast' })),
    )
    const toast = screen.getByText('Pointer persistent toast').closest('[data-slot="toast"]')!
    fireEvent.pointerEnter(toast)
    fireEvent.pointerLeave(toast)
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(screen.getByText('Pointer persistent toast')).toBeInTheDocument()
  })

  it('keeps a duration 0 toast open after focus leaves it', async () => {
    vi.useFakeTimers()
    render(
      <ToasterProvider>
        <DurationTrigger title="Focus persistent toast" seconds={0} />
        <button type="button">Outside focus target</button>
      </ToasterProvider>,
    )
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Show Focus persistent toast' })),
    )
    const toast = screen
      .getByText('Focus persistent toast')
      .closest('[data-slot="toast"]') as HTMLElement
    const close = within(toast).getByRole('button', { name: '' })
    const focusTarget = screen.getByRole('button', { name: 'Outside focus target' })
    fireEvent.focus(close)
    fireEvent.blur(close, { relatedTarget: focusTarget })
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(screen.getByText('Focus persistent toast')).toBeInTheDocument()
  })

  it('keeps the open toast after its duration changes from 10 seconds to 0', async () => {
    vi.useFakeTimers()
    render(
      <ToasterProvider>
        <ChangeableDurationTrigger />
      </ToasterProvider>,
    )
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Show changing duration toast' })),
    )
    await act(async () => vi.advanceTimersByTime(2000))
    fireEvent.click(screen.getByRole('button', { name: 'Keep notifications open' }))
    await act(async () => vi.advanceTimersByTime(58_000))
    expect(screen.getByText('Changing duration toast')).toBeInTheDocument()
  })

  it('starts a fresh timer after the last hovered toast is manually closed', async () => {
    vi.useFakeTimers()
    function TwoTriggers() {
      const { toast } = useToast()
      return (
        <>
          <button onClick={() => toast({ title: 'Toast A' })}>Show A</button>
          <button onClick={() => toast({ title: 'Toast B' })}>Show B</button>
        </>
      )
    }
    render(
      <ToasterProvider>
        <TwoTriggers />
      </ToasterProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show A' }))
    })
    const first = screen.getByText('Toast A').closest('[data-slot="toast"]')!
    fireEvent.pointerMove(first)
    fireEvent.click(screen.getByRole('button', { name: '' }))
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show B' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(5500)
    })
    expect(screen.queryByText('Toast B')).toBeNull()
  })

  it('pauses on hover and resumes with the remaining duration', async () => {
    vi.useFakeTimers()
    render(
      <ToasterProvider>
        <TestTrigger title="Paused toast" />
      </ToasterProvider>,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }))
    })
    const toast = screen.getByText('Paused toast').closest('[data-slot="toast"]')!
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    fireEvent.pointerEnter(toast)
    await act(async () => {
      vi.advanceTimersByTime(7000)
    })
    expect(screen.getByText('Paused toast')).toBeInTheDocument()
    fireEvent.pointerLeave(toast)
    await act(async () => {
      vi.advanceTimersByTime(2500)
    })
    expect(screen.queryByText('Paused toast')).toBeNull()
  })

  it('pauses only the toast under the pointer', async () => {
    vi.useFakeTimers()
    function TwoTriggers() {
      const { toast } = useToast()
      return (
        <button
          onClick={() => {
            toast({ title: 'Toast A' })
            toast({ title: 'Toast B' })
          }}
        >
          Show both
        </button>
      )
    }
    render(
      <ToasterProvider>
        <TwoTriggers />
      </ToasterProvider>,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show both' }))
    })
    fireEvent.pointerEnter(screen.getByText('Toast A').closest('[data-slot="toast"]')!)
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.getByText('Toast A')).toBeInTheDocument()
    expect(screen.queryByText('Toast B')).toBeNull()
  })

  it('keeps toast A timer running when toast B is added', async () => {
    vi.useFakeTimers()
    function TwoTriggers() {
      const { toast } = useToast()
      return (
        <div>
          <button onClick={() => toast({ title: 'Toast A' })}>Show A</button>
          <button onClick={() => toast({ title: 'Toast B' })}>Show B</button>
        </div>
      )
    }
    render(
      <ToasterProvider>
        <TwoTriggers />
      </ToasterProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show A' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show B' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(3500)
    })
    expect(screen.queryByText('Toast A')).toBeNull()
    expect(screen.getByText('Toast B')).toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.queryByText('Toast B')).toBeNull()
  })

  it('keeps toast A timer running when toast B is manually closed', async () => {
    vi.useFakeTimers()
    function TwoTriggers() {
      const { toast } = useToast()
      return (
        <div>
          <button onClick={() => toast({ title: 'Toast A' })}>Show A</button>
          <button onClick={() => toast({ title: 'Toast B' })}>Show B</button>
        </div>
      )
    }
    render(
      <ToasterProvider>
        <TwoTriggers />
      </ToasterProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show A' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
      fireEvent.click(screen.getByRole('button', { name: 'Show B' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    const second = screen.getByText('Toast B').closest('[data-slot="toast"]') as HTMLElement
    fireEvent.click(within(second).getByRole('button', { name: '' }))
    await act(async () => {
      vi.advanceTimersByTime(3500)
    })
    expect(screen.queryByText('Toast A')).toBeNull()
  })
})
