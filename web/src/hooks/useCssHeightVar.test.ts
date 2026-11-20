import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCssHeightVar } from './useCssHeightVar'

class FakeResizeObserver {
  static instance: FakeResizeObserver
  callback: ResizeObserverCallback
  observe = vi.fn()
  disconnect = vi.fn()

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.instance = this
  }
}

describe('useCssHeightVar', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--test-height')
    vi.unstubAllGlobals()
  })

  it('publishes height, follows resizes, and removes the variable on unmount', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const element = document.createElement('header')
    const bounds = vi
      .spyOn(element, 'getBoundingClientRect')
      .mockReturnValue({ height: 69.625 } as DOMRect)
    const ref = { current: element }
    const { unmount } = renderHook(() => useCssHeightVar(ref, '--test-height', true))

    expect(document.documentElement.style.getPropertyValue('--test-height')).toBe('69.625px')
    expect(FakeResizeObserver.instance.observe).toHaveBeenCalledWith(element)

    bounds.mockReturnValue({ height: 88.375 } as DOMRect)
    act(() => FakeResizeObserver.instance.callback([], FakeResizeObserver.instance as never))
    expect(document.documentElement.style.getPropertyValue('--test-height')).toBe('88.375px')

    unmount()
    expect(FakeResizeObserver.instance.disconnect).toHaveBeenCalled()
    expect(document.documentElement.style.getPropertyValue('--test-height')).toBe('')
  })

  it('does not publish a height when inactive', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    FakeResizeObserver.instance = undefined as unknown as FakeResizeObserver
    const ref = { current: document.createElement('header') }
    renderHook(() => useCssHeightVar(ref, '--test-height', false))

    expect(document.documentElement.style.getPropertyValue('--test-height')).toBe('')
    expect(FakeResizeObserver.instance).toBeUndefined()
  })
})
