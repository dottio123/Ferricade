import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DateRangeFilter } from './date-range-filter'

afterEach(cleanup)

it('keeps all five presets and emits the existing range updates', () => {
  const onChange = vi.fn()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-24T12:00:00Z'))
  render(<DateRangeFilter filters={{}} onChange={onChange} part="presets" />)
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
    'All time',
    '24h',
    '7d',
    '30d',
    'Custom',
  ])
  fireEvent.click(screen.getByText('7d'))
  expect(onChange).toHaveBeenLastCalledWith({
    range: '7d',
    since: '2026-10-17T12:00:00.000Z',
    until: undefined,
  })
  fireEvent.click(screen.getByText('All time'))
  expect(onChange).toHaveBeenLastCalledWith({
    range: undefined,
    since: undefined,
    until: undefined,
  })
  fireEvent.click(screen.getByText('Custom'))
  expect(onChange).toHaveBeenLastCalledWith({ range: 'custom' })
  vi.restoreAllMocks()
})

it('keeps partial custom dates and converts a complete date range', () => {
  const onChange = vi.fn()
  const { container, rerender } = render(
    <DateRangeFilter filters={{ range: 'custom' }} onChange={onChange} part="custom" />,
  )
  fireEvent.change(container.querySelectorAll('input')[0]!, { target: { value: '2026-10-01' } })
  expect(onChange).toHaveBeenLastCalledWith({ startDate: '2026-10-01', endDate: '' })
  rerender(
    <DateRangeFilter
      filters={{ range: 'custom', startDate: '2026-10-01' }}
      onChange={onChange}
      part="custom"
    />,
  )
  fireEvent.change(container.querySelectorAll('input')[1]!, { target: { value: '2026-10-02' } })
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      range: 'custom',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      since: expect.any(String),
      until: expect.any(String),
    }),
  )
})
