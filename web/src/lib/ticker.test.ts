import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dateRangeToIso,
  formatDuration,
  getTickerListenerCount,
  isTickerRunning,
  subscribeTicker,
} from './ticker'

describe('ticker clock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts interval on first subscriber and shares it among multiple subscribers', () => {
    expect(getTickerListenerCount()).toBe(0)
    expect(isTickerRunning()).toBe(false)

    const fn1 = vi.fn()
    const unsub1 = subscribeTicker(fn1)

    expect(getTickerListenerCount()).toBe(1)
    expect(isTickerRunning()).toBe(true)

    const fn2 = vi.fn()
    const unsub2 = subscribeTicker(fn2)

    expect(getTickerListenerCount()).toBe(2)
    expect(isTickerRunning()).toBe(true)

    // Advance 1 second: both listeners should fire once
    vi.advanceTimersByTime(1000)
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)

    // Advance another second: both listeners should fire a second time
    vi.advanceTimersByTime(1000)
    expect(fn1).toHaveBeenCalledTimes(2)
    expect(fn2).toHaveBeenCalledTimes(2)

    // Unsubscribe first listener: clock stays running with 1 listener
    unsub1()
    expect(getTickerListenerCount()).toBe(1)
    expect(isTickerRunning()).toBe(true)

    vi.advanceTimersByTime(1000)
    expect(fn1).toHaveBeenCalledTimes(2) // no new call
    expect(fn2).toHaveBeenCalledTimes(3) // new call

    // Unsubscribe last listener: clock stops
    unsub2()
    expect(getTickerListenerCount()).toBe(0)
    expect(isTickerRunning()).toBe(false)

    vi.advanceTimersByTime(1000)
    expect(fn2).toHaveBeenCalledTimes(3)
  })

  it('supports slower subscribers without changing the shared one-second ticker', () => {
    const fast = vi.fn()
    const header = vi.fn()
    const slow = vi.fn()
    const unsubscribeFast = subscribeTicker(fast)
    const unsubscribeHeader = subscribeTicker(header, 10000)
    const unsubscribeSlow = subscribeTicker(slow, 30000)

    vi.advanceTimersByTime(1000)
    expect(fast).toHaveBeenCalledTimes(1)
    expect(header).not.toHaveBeenCalled()
    expect(slow).not.toHaveBeenCalled()

    vi.advanceTimersByTime(9000)
    expect(header).toHaveBeenCalledTimes(1)
    expect(slow).not.toHaveBeenCalled()

    vi.advanceTimersByTime(20000)
    expect(fast).toHaveBeenCalledTimes(30)
    expect(header).toHaveBeenCalledTimes(3)
    expect(slow).toHaveBeenCalledTimes(1)

    unsubscribeFast()
    unsubscribeHeader()
    unsubscribeSlow()
  })
})

describe('formatDuration', () => {
  it('formats seconds only when under 60 seconds', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(12)).toBe('12s')
    expect(formatDuration(59)).toBe('59s')
  })

  it('formats minutes and seconds when under 1 hour', () => {
    expect(formatDuration(60)).toBe('1m')
    expect(formatDuration(72)).toBe('1m 12s')
    expect(formatDuration(252)).toBe('4m 12s')
    expect(formatDuration(3599)).toBe('59m 59s')
  })

  it('formats hours and minutes when 1 hour or more', () => {
    expect(formatDuration(3600)).toBe('1h')
    expect(formatDuration(3660)).toBe('1h 1m')
    expect(formatDuration(7200)).toBe('2h')
    expect(formatDuration(8100)).toBe('2h 15m')
  })
})

describe('dateRangeToIso', () => {
  it('converts start date to start of start day, and end date to start of the following day', () => {
    const range = dateRangeToIso('2026-10-01', '2026-10-05')

    const sinceDate = new Date(range.since)
    expect(sinceDate.getFullYear()).toBe(2026)
    expect(sinceDate.getMonth()).toBe(9) // October (0-indexed 9)
    expect(sinceDate.getDate()).toBe(1)
    expect(sinceDate.getHours()).toBe(0)
    expect(sinceDate.getMinutes()).toBe(0)
    expect(sinceDate.getSeconds()).toBe(0)
    expect(sinceDate.getMilliseconds()).toBe(0)

    const untilDate = new Date(range.until)
    expect(untilDate.getFullYear()).toBe(2026)
    expect(untilDate.getMonth()).toBe(9) // October
    expect(untilDate.getDate()).toBe(6) // 1 day after Oct 5 (exclusive upper bound)
    expect(untilDate.getHours()).toBe(0)
    expect(untilDate.getMinutes()).toBe(0)
    expect(untilDate.getSeconds()).toBe(0)
    expect(untilDate.getMilliseconds()).toBe(0)
  })

  it('handles month boundary correctly for following day', () => {
    const range = dateRangeToIso('2026-10-25', '2026-10-31')
    const untilDate = new Date(range.until)
    expect(untilDate.getFullYear()).toBe(2026)
    expect(untilDate.getMonth()).toBe(10) // November
    expect(untilDate.getDate()).toBe(1)
  })
})
