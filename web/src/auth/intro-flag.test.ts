import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearIntroFlag, INTRO_FLAG_KEY, readIntroFlag, setIntroFlag } from './intro-flag'

describe('intro-flag', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('defaults to false when unset', () => {
    expect(readIntroFlag()).toBe(false)
  })

  it('sets, reads, and clears the sessionStorage flag', () => {
    setIntroFlag()
    expect(sessionStorage.getItem(INTRO_FLAG_KEY)).toBe('1')
    expect(readIntroFlag()).toBe(true)

    clearIntroFlag()
    expect(sessionStorage.getItem(INTRO_FLAG_KEY)).toBeNull()
    expect(readIntroFlag()).toBe(false)
  })

  it('treats any unexpected value as false', () => {
    sessionStorage.setItem(INTRO_FLAG_KEY, '0')
    expect(readIntroFlag()).toBe(false)
  })

  it('swallows sessionStorage errors cleanly', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage blocked')
    })

    expect(() => setIntroFlag()).not.toThrow()
    expect(readIntroFlag()).toBe(false)
    expect(() => clearIntroFlag()).not.toThrow()
  })
})
