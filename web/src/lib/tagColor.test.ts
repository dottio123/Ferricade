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

  it('chooses the higher WCAG contrast ratio near the black/white crossover', () => {
    expect(textColorFor(0xff777777)).toBe('black')
    expect(textColorFor(0xff767676)).toBe('black')
    expect(textColorFor(0xff757575)).toBe('white')
  })

  it('composites translucent tags over the supplied page background', () => {
    expect(textColorFor(0x80ff0000, 0xffffffff)).toBe('black')
    expect(textColorFor(0x80ff0000, 0xff000000)).toBe('white')
  })

  it('always selects the better contrast for opaque and translucent colors', () => {
    const luminance = (channel: number) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }
    const ratio = (argb: number, text: 'black' | 'white', background: number) => {
      const color = argb >>> 0
      const ground = background >>> 0
      const alpha = ((color >>> 24) & 0xff) / 255
      const channels = [16, 8, 0].map(
        (shift) =>
          (((color >>> shift) & 0xff) * alpha + ((ground >>> shift) & 0xff) * (1 - alpha)) / 255,
      )
      const lum =
        0.2126 * luminance(channels[0]! * 255) +
        0.7152 * luminance(channels[1]! * 255) +
        0.0722 * luminance(channels[2]! * 255)
      return text === 'black' ? (lum + 0.05) / 0.05 : 1.05 / (lum + 0.05)
    }

    for (const color of [0xff777777, 0xff009688, 0x802196f3, 0x40ff5722]) {
      for (const ground of [0xffffffff, 0xff0b0f19]) {
        const selected = textColorFor(color, ground)
        expect(ratio(color, selected, ground)).toBeGreaterThanOrEqual(
          ratio(color, selected === 'black' ? 'white' : 'black', ground),
        )
      }
    }
  })
})
