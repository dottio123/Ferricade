import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { formatRelativeTime, RelativeTime } from './relative-time'

describe('RelativeTime component', () => {
  it('formats differences under 60 seconds either way as "just now"', () => {
    const now = 1700000000000
    // 30 seconds ago
    expect(formatRelativeTime(new Date(now - 30000), now)).toBe('just now')
    // 45 seconds in the future
    expect(formatRelativeTime(new Date(now + 45000), now)).toBe('just now')
    // 5 minutes ago
    expect(formatRelativeTime(new Date(now - 300000), now)).toBe('5m ago')
    // 2 hours ago
    expect(formatRelativeTime(new Date(now - 7200000), now)).toBe('2h ago')
  })

  it('renders "—" for invalid dates without throwing', () => {
    render(
      <TooltipProvider>
        <RelativeTime date="not-a-real-date" />
      </TooltipProvider>,
    )
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('does not have a title attribute on the time element to avoid doubling tooltip', () => {
    const validDate = new Date('2026-10-06T12:00:00Z')
    render(
      <TooltipProvider>
        <RelativeTime date={validDate} />
      </TooltipProvider>,
    )
    const timeEl = screen.getByRole('time', { hidden: true }) || document.querySelector('time')
    expect(timeEl).not.toBeNull()
    expect(timeEl?.getAttribute('title')).toBeNull()
  })
})
