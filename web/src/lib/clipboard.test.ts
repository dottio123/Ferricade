import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

describe('copyText clipboard helper', () => {
  const originalClipboard = navigator.clipboard

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
      writable: true,
    })
  })

  it('uses navigator.clipboard.writeText when available and returns "copied"', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    })

    const result = await copyText('secret-token-123')
    expect(writeTextMock).toHaveBeenCalledWith('secret-token-123')
    expect(result).toBe('copied')
  })

  it('falls back to document.execCommand when navigator.clipboard fails or is absent', async () => {
    // navigator.clipboard is absent
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    })

    const execCommandMock = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      value: execCommandMock,
      configurable: true,
      writable: true,
    })

    const result = await copyText('plain-http-token')
    expect(execCommandMock).toHaveBeenCalledWith('copy')
    expect(result).toBe('copied')
  })

  it('falls back to document.execCommand when navigator.clipboard.writeText throws', async () => {
    const writeTextMock = vi.fn().mockRejectedValue(new Error('Permission denied'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    })

    const execCommandMock = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      value: execCommandMock,
      configurable: true,
      writable: true,
    })

    const result = await copyText('plain-http-token')
    expect(writeTextMock).toHaveBeenCalledWith('plain-http-token')
    expect(execCommandMock).toHaveBeenCalledWith('copy')
    expect(result).toBe('copied')
  })

  it('returns "manual" when both navigator.clipboard and execCommand fail', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    })

    const execCommandMock = vi.fn().mockReturnValue(false)
    Object.defineProperty(document, 'execCommand', {
      value: execCommandMock,
      configurable: true,
      writable: true,
    })

    const result = await copyText('unsupported-env-token')
    expect(execCommandMock).toHaveBeenCalledWith('copy')
    expect(result).toBe('manual')
  })

  // The fallback focuses a hidden textarea to select it; a keyboard user must
  // land back on the button they pressed, and the textarea must never stay.
  describe('the execCommand fallback', () => {
    const noClipboard = () =>
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
        writable: true,
      })
    const execCommand = (impl: () => boolean) =>
      Object.defineProperty(document, 'execCommand', {
        value: vi.fn(impl),
        configurable: true,
        writable: true,
      })

    it('gives focus back to the element that had it', async () => {
      noClipboard()
      execCommand(() => true)
      const button = document.createElement('button')
      document.body.appendChild(button)
      button.focus()

      await copyText('x')
      expect(document.activeElement).toBe(button)
      button.remove()
    })

    it('removes the textarea even when execCommand throws', async () => {
      noClipboard()
      execCommand(() => {
        throw new Error('not allowed')
      })

      expect(await copyText('x')).toBe('manual')
      expect(document.querySelector('textarea')).toBeNull()
    })
  })
})
