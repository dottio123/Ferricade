import { describe, expect, it } from 'vitest'
import { fromCss, textColorFor, toCss } from './tagColor'

describe('tagColor helper', () => {
  it('converts full-alpha ARGB integers to hex CSS colors', () => {
    // 0xFF2196F3 -> 4280391411 (blue)
    expect(toCss(4280391411)).toBe('#2196f3')

    // 0xFF000000 -> 4278190080 (black)
    expect(toCss(4278190080)).toBe('#000000')

    // 0xFFFFFFFF -> 4294967295 (white)
    expect(toCss(4294967295)).toBe('#ffffff')

    // 0xFFFF5722 -> 4294924066 (orange)
    expect(toCss(4294924066)).toBe('#ff5722')
  })

  it('converts hex CSS colors to full-alpha ARGB integers', () => {
    expect(fromCss('#2196f3')).toBe(4280391411)
    expect(fromCss('#2196F3')).toBe(4280391411)
    expect(fromCss('#000000')).toBe(4278190080)
    expect(fromCss('#ffffff')).toBe(4294967295)
    expect(fromCss('ff5722')).toBe(4294924066)
    // 3-digit hex
    expect(fromCss('#fff')).toBe(4294967295)
    expect(fromCss('#000')).toBe(4278190080)
  })

  it('round-trips full-alpha ARGB through toCss and fromCss', () => {
    const testColors = [
      4280391411, // 0xFF2196F3
      4278190080, // 0xFF000000
      4294967295, // 0xFFFFFFFF
      4294924066, // 0xFFFF5722
      0xff4caf50 >>> 0,
      0xffff9800 >>> 0,
      0xff9c27b0 >>> 0,
      0xff009688 >>> 0,
    ]

    for (const color of testColors) {
      expect(fromCss(toCss(color))).toBe(color)
    }
  })

  it('converts translucent ARGB integers to rgba() strings', () => {
    // 0x802196F3 -> alpha ~ 0.502
    expect(toCss(0x802196f3)).toBe('rgba(33, 150, 243, 0.502)')

    // 0x00FFFFFF -> fully transparent
    expect(toCss(0x00ffffff)).toBe('rgba(255, 255, 255, 0)')
  })

  it('calculates readable high-contrast text color (black or white)', () => {
    // Black background needs white text
    expect(textColorFor(0xff000000)).toBe('white')

    // White background needs black text
    expect(textColorFor(0xffffffff)).toBe('black')

    // Dark blue (0xFF0D47A1) needs white text
    expect(textColorFor(0xff0d47a1)).toBe('white')

    // Light yellow (0xFFFFF59D) needs black text
    expect(textColorFor(0xfffff59d)).toBe('black')

    // 0xFF2196F3 (Material Blue) -> luminance is ~0.29, best with black text (or tested cutoff)
    expect(textColorFor(4280391411)).toBe('black')
  })
})
