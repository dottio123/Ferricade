import { useLayoutEffect, type RefObject } from 'react'

// Publishes an element's height as a CSS variable on <html>, so things pinned under it
// (sticky bars, scroll-padding) follow when it wraps or changes size.
export function useCssHeightVar(
  ref: RefObject<HTMLElement | null>,
  name: `--${string}`,
  active: boolean,
): void {
  useLayoutEffect(() => {
    const root = document.documentElement
    const el = ref.current
    if (!active || !el) {
      root.style.removeProperty(name)
      return
    }
    const update = () => root.style.setProperty(name, `${el.getBoundingClientRect().height}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      observer.disconnect()
      root.style.removeProperty(name)
    }
  }, [ref, name, active])
}
