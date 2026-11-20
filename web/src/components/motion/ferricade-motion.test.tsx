import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FerricadeIntro } from './ferricade-intro'
import { FerricadeLoader } from './ferricade-loader'

const motionCssPath = resolve(process.cwd(), 'src/styles/motion.css')
const indexCssPath = resolve(process.cwd(), 'src/styles/index.css')

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? reduced : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

beforeEach(() => {
  stubReducedMotion(false)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cleanup()
})

describe('FerricadeLoader', () => {
  it('renders role="status" with accessible name "Loading" and no inline styles', () => {
    const { container } = render(<FerricadeLoader fullPage />)
    const status = screen.getByRole('status', { name: 'Loading' })
    expect(status).toBeInTheDocument()
    expect(container.querySelector('style')).toBeNull()
    expect(container.querySelector('[style]')).toBeNull()
    const svg = container.querySelector('svg.fx')
    expect(svg).not.toBeNull()
    expect(svg?.querySelector('.fx-ink')).not.toBeNull()
  })

  it('defines motion rules in motion.css with --brand-ink, fixed kit rust hexes, and reduced-motion override', () => {
    const indexCss = readFileSync(indexCssPath, 'utf-8')
    expect(indexCss).toMatch(/@import\s+['"]\.\/motion\.css['"];/)

    const css = readFileSync(motionCssPath, 'utf-8')
    expect(css).toMatch(/--fx-ink:\s*var\(--brand-ink\)/)
    expect(css).toMatch(/--fx-ring:\s*var\(--brand-ink\)/)
    expect(css).toMatch(/--fx-rim:\s*#56200b/i)
    expect(css).toMatch(/--fx-rim:\s*#843210/i)
    expect(css).toMatch(/--fx-glow:\s*#f08a4a/i)
    expect(css).toMatch(/--fx-glow:\s*#f5ae78/i)
    expect(css).not.toMatch(/--fx-(?:rim|face|warm|bright|dark|pit|flake|glow):\s*var\(--primary/)
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(css).toMatch(/\.fx\s+\.fi-f[\s\S]*fx-in\s+0\.6s\s+ease\s+both\s*!important/)
  })
})

describe('FerricadeIntro', () => {
  it('renders full-page intro with no inline styles and completes after full animation', () => {
    vi.useFakeTimers()
    const onComplete = vi.fn()
    const { container } = render(<FerricadeIntro onComplete={onComplete} />)

    expect(screen.getByRole('img', { name: 'Ferricade' })).toBeInTheDocument()
    expect(container.querySelector('[data-slot="brand-intro"]')).not.toBeNull()
    expect(container.querySelector('style')).toBeNull()
    expect(container.querySelector('[style]')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(4500)
    })
    expect(onComplete).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('skips immediately on click', () => {
    vi.useFakeTimers()
    const onComplete = vi.fn()
    const { container } = render(<FerricadeIntro onComplete={onComplete} />)

    const overlay = container.querySelector('[data-slot="brand-intro"]') as HTMLElement
    fireEvent.click(overlay)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('skips immediately on non-modifier key press and ignores bare modifiers / shortcuts', () => {
    vi.useFakeTimers()
    const onComplete = vi.fn()
    render(<FerricadeIntro onComplete={onComplete} />)

    fireEvent.keyDown(window, { key: 'Shift' })
    fireEvent.keyDown(window, { key: 'r', ctrlKey: true })
    expect(onComplete).not.toHaveBeenCalled()

    const ev = new KeyboardEvent('keydown', { key: ' ', cancelable: true })
    const notCancelled = window.dispatchEvent(ev)
    expect(notCancelled).toBe(false)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('completes on the short static-fade schedule when prefers-reduced-motion is reduce', () => {
    stubReducedMotion(true)
    vi.useFakeTimers()
    const onComplete = vi.fn()
    render(<FerricadeIntro onComplete={onComplete} />)

    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(onComplete).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(800)
    })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
