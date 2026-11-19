import { afterEach, describe, expect, it } from 'vitest'
import { getPlatformKeyHint } from './platform'

describe('getPlatformKeyHint', () => {
  const originalNavigator = window.navigator

  afterEach(() => {
    Object.defineProperty(window, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    })
  })

  function setNavigator(nav: { userAgentData?: { platform?: string }; userAgent?: string }) {
    Object.defineProperty(window, 'navigator', {
      value: nav,
      configurable: true,
      writable: true,
    })
  }

  it('returns ⌘K for macOS via userAgentData', () => {
    setNavigator({
      userAgentData: { platform: 'macOS' },
      userAgent: 'Mozilla/5.0',
    })
    expect(getPlatformKeyHint()).toBe('⌘K')
  })

  it('returns Ctrl K for Windows via userAgentData', () => {
    setNavigator({
      userAgentData: { platform: 'Windows' },
      userAgent: 'Mozilla/5.0',
    })
    expect(getPlatformKeyHint()).toBe('Ctrl K')
  })

  it('returns Ctrl K for Linux via userAgentData', () => {
    setNavigator({
      userAgentData: { platform: 'Linux' },
      userAgent: 'Mozilla/5.0',
    })
    expect(getPlatformKeyHint()).toBe('Ctrl K')
  })

  it('falls back to userAgent and returns ⌘K for macOS', () => {
    setNavigator({
      userAgentData: undefined,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
    expect(getPlatformKeyHint()).toBe('⌘K')
  })

  it('falls back to userAgent and returns Ctrl K for Windows', () => {
    setNavigator({
      userAgentData: undefined,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    })
    expect(getPlatformKeyHint()).toBe('Ctrl K')
  })

  it('falls back to userAgent and returns Ctrl K for Linux', () => {
    setNavigator({
      userAgentData: undefined,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    })
    expect(getPlatformKeyHint()).toBe('Ctrl K')
  })
})
