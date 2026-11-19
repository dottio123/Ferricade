import * as React from 'react'

const HISTORY = 20

// Remembers where focus was before an overlay took it, so closing the overlay
// can put it back (WCAG 2.4.3). Overlays here are often opened from state, not
// from a Radix trigger, so Radix has no trigger to return to.
export function useOverlayFocusState(enabled = true) {
  // Registered by each overlay root, so the Escape listener below can close the topmost.
  const closers = React.useRef(new Map<string, () => void>())
  // Every element that took focus, oldest first. Tracking starts at page load
  // (the provider is at the app root) because a field inside the overlay can
  // focus itself (autoFocus) on mount, and Radix then skips onOpenAutoFocus
  // altogether, so there is no open-time hook to read activeElement in.
  const history = React.useRef<HTMLElement[]>([])
  React.useEffect(() => {
    if (!enabled) return
    const remember = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const list = history.current
      if (list[list.length - 1] === target) return
      list.push(target)
      if (list.length > HISTORY) list.shift()
    }
    document.addEventListener('focusin', remember, true)
    // Escape closes the topmost open overlay. Radix's own handler depends on a
    // render-time "am I the top layer" flag that can be stale for a render after
    // a nested overlay opened; measured in the device panel, the Sheet then
    // claimed the keypress and the confirm dialog's handler never ran, or both
    // closed. Handling it once here (registered before Radix's, and calling
    // preventDefault, which Radix honours) removes the race.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // A menu, select, popover or tooltip above the overlay owns this Escape;
      // Radix closes it, and the overlay behind keeps its place.
      const topEl = topmostOverlayElement()
      if (!topEl) return
      const above = Array.from(document.querySelectorAll(ABOVE_OVERLAY)).some(
        (el) => topEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
      if (above) return
      const top = topEl.dataset.overlayId ?? null
      const close = top ? closers.current.get(top) : undefined
      if (!close) return
      event.preventDefault()
      close()
    }
    document.addEventListener('focusin', remember, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('focusin', remember, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [enabled])

  // The overlay's own content is the event target of Radix's focus events. An
  // opener inside another (outer) overlay still counts; only the overlay being
  // opened or closed is excluded.
  const outside = (content: EventTarget | null) => (el: HTMLElement | null) =>
    el !== null && !(content instanceof Node && content.contains(el))

  return {
    closers,
    restoreFocus(event: Event, fallbackSelector?: string) {
      const isOutside = outside(event.target)
      let target: HTMLElement | null = null
      for (let i = history.current.length - 1; i >= 0; i--) {
        const el = history.current[i] ?? null
        if (isOutside(el) && document.contains(el)) {
          target = el
          break
        }
      }
      if (!target && fallbackSelector)
        target = document.querySelector<HTMLElement>(fallbackSelector)
      if (target) {
        event.preventDefault()
        target.focus()
      }
    },
  }
}

type FocusState = ReturnType<typeof useOverlayFocusState>
export const OverlayFocusContext = React.createContext<FocusState | null>(null)

export function OverlayFocusProvider({ children }: { children: React.ReactNode }) {
  const focus = useOverlayFocusState()
  return <OverlayFocusContext.Provider value={focus}>{children}</OverlayFocusContext.Provider>
}

export function useOverlayFocus(): FocusState {
  const inherited = React.useContext(OverlayFocusContext)
  const local = useOverlayFocusState(inherited === null)
  return inherited ?? local
}

const ABOVE_OVERLAY = '[data-radix-popper-content-wrapper], [role="menu"], [role="listbox"]'
const OverlayIdContext = React.createContext<string | null>(null)

function topmostOverlayElement(): HTMLElement | null {
  const open = document.querySelectorAll<HTMLElement>('[data-overlay-content][data-state="open"]')
  return open[open.length - 1] ?? null
}

export function useNestedCloseGuard(
  onOpenChange: ((open: boolean) => void) | undefined,
  closers: React.RefObject<Map<string, () => void>>,
  controlled: boolean,
) {
  const id = React.useId()
  const guarded = (open: boolean) => {
    if (!open) {
      const openOverlays = Array.from(
        document.querySelectorAll<HTMLElement>('[data-overlay-content][data-state="open"]'),
      )
      const mine = openOverlays.findIndex((el) => el.dataset.overlayId === id)
      if (mine !== -1 && mine < openOverlays.length - 1) return
    }
    onOpenChange?.(open)
  }
  const latest = React.useRef(guarded)
  React.useEffect(() => {
    latest.current = guarded
  })
  React.useEffect(() => {
    // An uncontrolled overlay can only be closed by Radix itself.
    if (!controlled) return
    const map = closers.current
    map.set(id, () => latest.current(false))
    return () => {
      map.delete(id)
    }
  }, [id, closers, controlled])
  return { id, guarded }
}

export function OverlayIdProvider({ id, children }: { id: string; children: React.ReactNode }) {
  return <OverlayIdContext.Provider value={id}>{children}</OverlayIdContext.Provider>
}

export function useOverlayId() {
  return React.useContext(OverlayIdContext)
}
