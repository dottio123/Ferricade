import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusDot } from './status-dot'

describe('StatusDot', () => {
  it('re-renders with a new status without crashing in jsdom', () => {
    // In standard jsdom, window.matchMedia is undefined.
    const { container, rerender } = render(<StatusDot status="offline" />)
    const dot = container.querySelector('[data-testid="status-dot"]')
    expect(dot).toBeInTheDocument()
    expect(dot).toHaveAttribute('data-status', 'offline')
    expect(dot).not.toHaveClass('animate-status-pulse')

    // Rerender with a new status triggers the status transition
    rerender(<StatusDot status="online" />)
    expect(dot).toHaveAttribute('data-status', 'online')
    expect(dot).toHaveClass('animate-status-pulse')
  })

  it('respects prefers-reduced-motion when matchMedia is present', () => {
    const originalMatchMedia = window.matchMedia
    try {
      window.matchMedia = ((query: string) => ({
        matches: query.includes('prefers-reduced-motion: reduce'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia

      const { container, rerender } = render(<StatusDot status="offline" />)
      const dot = container.querySelector('[data-testid="status-dot"]')
      rerender(<StatusDot status="online" />)

      expect(dot).toHaveAttribute('data-status', 'online')
      expect(dot).not.toHaveClass('animate-status-pulse')
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })
})
