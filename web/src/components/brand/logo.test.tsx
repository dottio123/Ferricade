import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FMark } from './f-mark'
import { Wordmark } from './wordmark'

afterEach(cleanup)

const brandCssPath = resolve(process.cwd(), 'src/styles/brand.css')
const indexCssPath = resolve(process.cwd(), 'src/styles/index.css')

describe('Brand logo components', () => {
  it('renders Wordmark and FMark with accessible name "Ferricade" by default', () => {
    render(
      <div>
        <Wordmark />
        <FMark />
      </div>,
    )
    const images = screen.getAllByRole('img', { name: 'Ferricade' })
    expect(images).toHaveLength(2)
    expect(images[0]).toHaveAttribute('data-brand-logo', 'wordmark')
    expect(images[1]).toHaveAttribute('data-brand-logo', 'f-mark')
  })

  it('hides decorative logos from the accessibility tree', () => {
    const { container } = render(
      <div>
        <Wordmark decorative />
        <FMark decorative />
      </div>,
    )
    expect(screen.queryByRole('img')).toBeNull()
    const svgs = container.querySelectorAll('svg')
    expect(svgs).toHaveLength(2)
    for (const svg of svgs) {
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg).not.toHaveAttribute('aria-label')
    }
  })

  it('uses the --brand-ink token for ink parts instead of plain text color', () => {
    const { container } = render(
      <div>
        <Wordmark variant="flat" />
        <Wordmark variant="rust" />
        <FMark variant="flat" />
        <FMark variant="rust" />
      </div>,
    )
    const svgs = container.querySelectorAll('svg')
    for (const svg of svgs) {
      expect(svg).toHaveClass('text-brand-ink')
    }
    const inkPaths = container.querySelectorAll('[data-brand-part="ink"]')
    expect(inkPaths.length).toBeGreaterThan(4)
    for (const path of inkPaths) {
      expect(path).toHaveClass('fc-logo-ink')
      expect(path.getAttribute('fill')).toBeNull()
    }
  })

  it('uses brand rust classes and never theme tokens or hardcoded hex fills on rust tip parts', () => {
    const { container } = render(
      <div>
        <Wordmark variant="flat" />
        <FMark variant="flat" />
        <Wordmark variant="rust" />
        <FMark variant="rust" />
      </div>,
    )
    const rustParts = container.querySelectorAll('[data-brand-part="rust"]')
    expect(rustParts.length).toBe(6)
    for (const part of rustParts) {
      expect(part).toHaveClass('fc-logo-rust')
      expect(part.getAttribute('fill')).toBeNull()
    }
  })

  it('defines exact brand rust hexes (#B7410E light / #D65C26 dark) and <360px flat rule in brand.css', () => {
    const indexCss = readFileSync(indexCssPath, 'utf-8')
    expect(indexCss).toMatch(/@import\s+['"]\.\/brand\.css['"];/)
    expect(indexCss).toMatch(/--color-brand-ink:\s*var\(--brand-ink\);/)

    const brandCss = readFileSync(brandCssPath, 'utf-8')
    expect(brandCss).toMatch(/\.fc-logo-ink\s*\{\s*fill:\s*var\(--brand-ink\);/)
    expect(brandCss).toMatch(/--fc-brand-rust:\s*#b7410e/i)
    expect(brandCss).toMatch(/--fc-brand-rust:\s*#d65c26/i)
    expect(brandCss).not.toMatch(/var\(--primary/)
    expect(brandCss).toMatch(/@media\s*\(max-width:\s*359px\)/)
    expect(brandCss).toMatch(/\.fc-logo-rust\s*\{\s*fill:\s*var\(--fc-brand-rust\)/)
  })
})
