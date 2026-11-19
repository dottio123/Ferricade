import * as React from 'react'

export interface UseWallFitOptions {
  isWall?: boolean
  count: number
  defaultMax: number
}

export interface UseWallFitReturn {
  containerRef: React.RefObject<HTMLDivElement | null>
  listRef: React.RefObject<HTMLDivElement | null>
  visibleCount: number
  hiddenCount: number
}

/**
 * Shared wall-preset dynamic height calculation hook.
 *
 * In the Monitoring wall preset, calculates how many rows fit inside the
 * module container without causing vertical scrollbars.
 */
export function useWallFit({
  isWall = false,
  count,
  defaultMax,
}: UseWallFitOptions): UseWallFitReturn {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [wallFitCount, setWallFitCount] = React.useState<number>(2)

  const calculateFit = React.useCallback(() => {
    if (!isWall) return
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setWallFitCount(defaultMax)
      return
    }
    const container = containerRef.current
    if (!container) return

    const containerHeight = container.clientHeight
    if (containerHeight <= 0) return

    const firstRow = listRef.current?.firstElementChild as HTMLElement | null
    const rowHeight = firstRow ? firstRow.offsetHeight : 54
    const moreHeight = 28

    if (count * rowHeight <= containerHeight) {
      setWallFitCount((prev) => (prev === count ? prev : count))
      return
    }

    const availableForRows = containerHeight - moreHeight
    const fit = Math.max(1, Math.floor(availableForRows / rowHeight))
    const nextCount = Math.min(fit, count)
    setWallFitCount((prev) => (prev === nextCount ? prev : nextCount))
  }, [isWall, count, defaultMax])

  React.useLayoutEffect(() => {
    if (!isWall) return
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      calculateFit()
    })
    observer.observe(container)
    calculateFit()
    return () => observer.disconnect()
  }, [isWall, calculateFit])

  const visibleCount = isWall ? wallFitCount : defaultMax
  const hiddenCount = Math.max(0, count - visibleCount)

  return {
    containerRef,
    listRef,
    visibleCount,
    hiddenCount,
  }
}
