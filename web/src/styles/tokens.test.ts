/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Palette } from '@/lib/appearance'

const THEMES = [
  'ferricade',
  'indigo',
  'graphite',
  'ocean',
  'violet',
  'moss',
  'sandstone',
] as const satisfies readonly Palette[]

const tokensCssPath = resolve(process.cwd(), 'src/styles/tokens.css')
const tokensRaw = readFileSync(tokensCssPath, 'utf-8')

/** Parses hex color to sRGB [r, g, b] (0-255). */
function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim()
  const num = parseInt(clean, 16)
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
}

/** Computes single channel sRGB relative luminance according to WCAG 2.1. */
function channelLuminance(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** Computes relative luminance of a hex color (0 to 1). */
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

/** Computes WCAG contrast ratio between two hex colors (1 to 21). */
function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1)
  const l2 = relativeLuminance(hex2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Composites a foreground color with alpha opacity over an opaque background color.
 * Returns the resulting hex color (#rrggbb).
 */
function compositeColor(fgHex: string, alpha: number, bgHex: string): string {
  const [fgR, fgG, fgB] = hexToRgb(fgHex)
  const [bgR, bgG, bgB] = hexToRgb(bgHex)
  const r = Math.round(fgR * alpha + bgR * (1 - alpha))
  const g = Math.round(fgG * alpha + bgG * (1 - alpha))
  const b = Math.round(fgB * alpha + bgB * (1 - alpha))
  const toHex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/** Parses CSS variable declarations from a CSS block string. */
function parseCssVariables(cssBlock: string): Record<string, string> {
  const vars: Record<string, string> = {}
  const regex = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(cssBlock)) !== null) {
    const name = match[1]
    const value = match[2]
    if (name && value) {
      const trimmed = value.trim()
      if (trimmed.startsWith('#')) {
        vars[name] = trimmed
      }
    }
  }
  return vars
}

/** Extracts theme blocks from tokens.css */
function extractThemeTokens(palette: Palette): {
  light: Record<string, string>
  dark: Record<string, string>
  mediaDark: Record<string, string>
  names: { light: string[]; dark: string[]; mediaDark: string[] }
} {
  const esc = palette.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lightSelector =
    palette === 'indigo'
      ? '^:root\\s*,\\s*\\[data-theme=["\']light["\']\\]'
      : `^\\[data-palette=["']${esc}["']\\],\\s*\\n\\[data-palette=["']${esc}["']\\]\\[data-theme=["']light["']\\]`
  const darkSelector =
    palette === 'indigo'
      ? '^\\[data-theme=["\']dark["\']\\]'
      : `^\\[data-palette=["']${esc}["']\\]\\[data-theme=["']dark["']\\]`
  const mediaSelector =
    palette === 'indigo'
      ? ':root:not\\(\\[data-theme=["\']light["\']\\]\\)'
      : `\\[data-palette=["']${esc}["']\\]:not\\(\\[data-theme=["']light["']\\]\\)`
  const lightBlockMatch = tokensRaw.match(
    new RegExp(`${lightSelector}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'),
  )
  if (!lightBlockMatch || !lightBlockMatch[1]) {
    throw new Error(`Could not find ${palette} light theme block in tokens.css`)
  }
  const light = parseCssVariables(lightBlockMatch[1])

  const darkBlockMatch = tokensRaw.match(
    new RegExp(`${darkSelector}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'),
  )
  if (!darkBlockMatch || !darkBlockMatch[1]) {
    throw new Error(`Could not find ${palette} dark theme block in tokens.css`)
  }
  const dark = parseCssVariables(darkBlockMatch[1])

  const mediaDarkMatch = tokensRaw.match(
    new RegExp(
      `@media\\s*\\(\\s*prefers-color-scheme:\\s*dark\\s*\\)\\s*\\{[\\s\\S]*?${mediaSelector}\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\s*\\n\\}`,
      'm',
    ),
  )
  if (!mediaDarkMatch || !mediaDarkMatch[1]) {
    throw new Error(
      `Could not find ${palette} media (prefers-color-scheme: dark) block in tokens.css`,
    )
  }
  const mediaDark = parseCssVariables(mediaDarkMatch[1])
  const names = {
    light: [...lightBlockMatch[1].matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]!).sort(),
    dark: [...darkBlockMatch[1].matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]!).sort(),
    mediaDark: [...mediaDarkMatch[1].matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]!).sort(),
  }

  return { light, dark, mediaDark, names }
}

const DEFAULT_DARK_NAMES = extractThemeTokens('indigo').names.dark.filter(
  (name) => name !== '--primary-text',
)

describe.each(THEMES)('Design tokens WCAG 2.2 AA contrast compliance: %s', (palette) => {
  const { light, dark, mediaDark, names } = extractThemeTokens(palette)
  function get(tokens: Record<string, string>, name: string): string {
    const val = tokens[name]
    if (!val) throw new Error(`Missing token ${name}`)
    return val
  }

  it('defines a complete palette without redefining non-colour tokens', () => {
    if (palette === 'indigo') {
      expect(names.dark.every((name) => names.light.includes(name))).toBe(true)
    } else if (palette === 'ferricade') {
      const ferricadeNames = [...DEFAULT_DARK_NAMES, '--primary-text'].sort()
      expect(names.light).toEqual(ferricadeNames)
      expect(names.mediaDark).toEqual(ferricadeNames)
      expect(names.dark).toEqual(ferricadeNames)
    } else {
      expect(names.light).toEqual(DEFAULT_DARK_NAMES)
      expect(names.mediaDark).toEqual(DEFAULT_DARK_NAMES)
      expect(names.dark).toEqual(DEFAULT_DARK_NAMES)
    }
  })

  it('keeps Indigo colour values unchanged', () => {
    if (palette !== 'indigo') return
    // Never update this snapshot with -u; a theme task changes other blocks, never these.
    const { '--brand-ink': lightBrandInk, ...lightRest } = light
    const { '--brand-ink': darkBrandInk, ...darkRest } = dark
    expect(lightBrandInk).toBeDefined()
    expect(darkBrandInk).toBeDefined()
    expect(mediaDark['--brand-ink']).toBe(darkBrandInk)
    expect({ light: lightRest, dark: darkRest }).toMatchInlineSnapshot(`
      {
        "dark": {
          "--accent": "#1e293b",
          "--accent-foreground": "#f8fafc",
          "--background": "#0b0f19",
          "--border": "#1e293b",
          "--card": "#111827",
          "--card-foreground": "#f8fafc",
          "--chart-1": "#818cf8",
          "--chart-2": "#22c55e",
          "--chart-3": "#f59e0b",
          "--chart-4": "#f87171",
          "--chart-5": "#38bdf8",
          "--chrome": "#0f1322",
          "--chrome-foreground": "#f8fafc",
          "--destructive": "#dc2626",
          "--destructive-foreground": "#ffffff",
          "--destructive-text": "#f87171",
          "--foreground": "#f8fafc",
          "--input": "#334155",
          "--muted": "#1e293b",
          "--muted-foreground": "#94a3b8",
          "--nav-active": "#1e1b4b",
          "--nav-active-foreground": "#c7d2fe",
          "--popover": "#111827",
          "--popover-foreground": "#f8fafc",
          "--primary": "#818cf8",
          "--primary-foreground": "#0b0f19",
          "--ring": "#818cf8",
          "--secondary": "#1e293b",
          "--secondary-foreground": "#f8fafc",
          "--status-alert": "#f87171",
          "--status-live": "#818cf8",
          "--status-offline": "#94a3b8",
          "--status-online": "#22c55e",
          "--status-online-fg": "#22c55e",
          "--status-pending": "#f59e0b",
          "--surface-1": "#111827",
          "--surface-2": "#1e293b",
          "--surface-3": "#334155",
        },
        "light": {
          "--accent": "#f1f5f9",
          "--accent-foreground": "#0f172a",
          "--background": "#ffffff",
          "--border": "#e2e8f0",
          "--card": "#ffffff",
          "--card-foreground": "#0f172a",
          "--chart-1": "#4338ca",
          "--chart-2": "#15803d",
          "--chart-3": "#92400e",
          "--chart-4": "#b91c1c",
          "--chart-5": "#0284c7",
          "--chrome": "#f8f9fe",
          "--chrome-foreground": "#0f172a",
          "--destructive": "#dc2626",
          "--destructive-foreground": "#ffffff",
          "--destructive-text": "#dc2626",
          "--foreground": "#0f172a",
          "--input": "#e2e8f0",
          "--muted": "#f1f5f9",
          "--muted-foreground": "#475569",
          "--nav-active": "#eef2ff",
          "--nav-active-foreground": "#312e81",
          "--popover": "#ffffff",
          "--popover-foreground": "#0f172a",
          "--primary": "#4338ca",
          "--primary-foreground": "#ffffff",
          "--ring": "#4338ca",
          "--secondary": "#f1f5f9",
          "--secondary-foreground": "#0f172a",
          "--status-alert": "#b91c1c",
          "--status-live": "#4338ca",
          "--status-offline": "#475569",
          "--status-online": "#15803d",
          "--status-online-fg": "#065f46",
          "--status-pending": "#92400e",
          "--surface-1": "#ffffff",
          "--surface-2": "#f8fafc",
          "--surface-3": "#f1f5f9",
        },
      }
    `)
  })
  it('successfully parsed essential color tokens from tokens.css', () => {
    expect(light['--background']).toBeDefined()
    expect(light['--foreground']).toBeDefined()
    expect(light['--primary']).toBeDefined()
    expect(dark['--background']).toBeDefined()
    expect(dark['--foreground']).toBeDefined()
    expect(dark['--primary']).toBeDefined()
    expect(mediaDark['--background']).toBeDefined()
    expect(mediaDark['--foreground']).toBeDefined()
    expect(mediaDark['--primary']).toBeDefined()
  })

  it('dark block inside @media (prefers-color-scheme: dark) equals [data-theme="dark"] block', () => {
    expect(mediaDark).toEqual(dark)
  })

  it('--status-live equals --primary in both themes', () => {
    if (palette === 'ferricade') {
      expect(get(light, '--status-live')).toBe(get(light, '--primary-text'))
      expect(get(dark, '--status-live')).toBe(get(dark, '--primary-text'))
      expect(get(mediaDark, '--status-live')).toBe(get(mediaDark, '--primary-text'))
    } else {
      expect(get(light, '--status-live')).toBe(get(light, '--primary'))
      expect(get(dark, '--status-live')).toBe(get(dark, '--primary'))
      expect(get(mediaDark, '--status-live')).toBe(get(mediaDark, '--primary'))
    }
  })

  it('keeps Ferricade accent text at WCAG AA on its surfaces', () => {
    if (palette !== 'ferricade') return
    for (const tokens of [light, dark, mediaDark]) {
      for (const surface of ['--background', '--card', '--chrome', '--nav-active']) {
        expect(
          contrastRatio(get(tokens, '--primary-text'), get(tokens, surface)),
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps Ferricade alert labels at WCAG AA over tinted surfaces', () => {
    if (palette !== 'ferricade') return
    for (const surface of ['--background', '--card', '--muted', '--chrome']) {
      const tinted = compositeColor(get(light, '--status-alert'), 0.15, get(light, surface))
      expect(contrastRatio(get(light, '--status-alert'), tinted)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps Ferricade muted text at WCAG AA when rendered at 80% opacity', () => {
    if (palette !== 'ferricade') return
    for (const surface of ['--background', '--card', '--muted', '--chrome']) {
      const muted = compositeColor(get(light, '--muted-foreground'), 0.8, get(light, surface))
      expect(contrastRatio(muted, get(light, surface))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps the approved Ferricade ground, text, and brand accents', () => {
    if (palette !== 'ferricade') return
    expect([light['--background'], light['--foreground'], light['--primary']]).toEqual([
      '#f0eeeb',
      '#2b2e33',
      '#b7410e',
    ])
    expect([dark['--background'], dark['--foreground'], dark['--primary']]).toEqual([
      '#181a1d',
      '#ece6dc',
      '#d65c26',
    ])
    expect(light['--brand-ink']).toBe('#2b2e33')
    expect(dark['--brand-ink']).toBe('#ece6dc')
    expect(mediaDark['--brand-ink']).toBe('#ece6dc')
  })

  describe('Light Theme Contrast', () => {
    it('foreground text passes AA (>= 4.5:1) against background, card, and popover', () => {
      expect(
        contrastRatio(get(light, '--foreground'), get(light, '--background')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(light, '--card-foreground'), get(light, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(light, '--popover-foreground'), get(light, '--popover')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('primary button text passes AA (>= 4.5:1) against primary filled background', () => {
      expect(
        contrastRatio(get(light, '--primary-foreground'), get(light, '--primary')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('secondary and muted foregrounds pass AA (>= 4.5:1) against their backgrounds', () => {
      expect(
        contrastRatio(get(light, '--secondary-foreground'), get(light, '--secondary')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(light, '--muted-foreground'), get(light, '--background')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(light, '--muted-foreground'), get(light, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('destructive button text passes AA (>= 4.5:1)', () => {
      expect(
        contrastRatio(get(light, '--destructive-foreground'), get(light, '--destructive')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('destructive text passes AA (>= 4.5:1) against card surface', () => {
      expect(
        contrastRatio(get(light, '--destructive-text'), get(light, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('status colors pass AA (>= 4.5:1) against card surface', () => {
      expect(
        contrastRatio(get(light, '--status-online'), get(light, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(light, '--status-pending'), get(light, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(light, '--status-offline'), get(light, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(light, '--status-alert'), get(light, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(light, '--status-live'), get(light, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('--status-online-fg passes AA (>= 4.5:1) against background and card surface', () => {
      expect(
        contrastRatio(get(light, '--status-online-fg'), get(light, '--background')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(light, '--status-online-fg'), get(light, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('--status-online-fg passes AA (>= 4.5:1) against tinted surfaces (15% and 10% over background and card)', () => {
      const fg = get(light, '--status-online-fg')
      const tint = get(light, '--status-online')
      for (const surfaceName of ['--background', '--card'] as const) {
        const bg = get(light, surfaceName)
        const tint15 = compositeColor(tint, 0.15, bg)
        const tint10 = compositeColor(tint, 0.1, bg)
        expect(contrastRatio(fg, tint15)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(fg, tint10)).toBeGreaterThanOrEqual(4.5)
      }
    })

    it('--status-pending passes AA (>= 4.5:1) against tinted surfaces (15% and 10% over background and card)', () => {
      const fg = get(light, '--status-pending')
      const tint = get(light, '--status-pending')
      for (const surfaceName of ['--background', '--card'] as const) {
        const bg = get(light, surfaceName)
        const tint15 = compositeColor(tint, 0.15, bg)
        const tint10 = compositeColor(tint, 0.1, bg)
        expect(contrastRatio(fg, tint15)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(fg, tint10)).toBeGreaterThanOrEqual(4.5)
      }
    })

    it('--status-pending passes AA (>= 4.5:1) against tinted surfaces (15% tint over --nav-active and --chrome)', () => {
      const fg = get(light, '--status-pending')
      const tint = get(light, '--status-pending')
      for (const surfaceName of ['--nav-active', '--chrome'] as const) {
        const bg = get(light, surfaceName)
        const tint15 = compositeColor(tint, 0.15, bg)
        expect(contrastRatio(fg, tint15)).toBeGreaterThanOrEqual(4.5)
      }
    })

    it('--chrome-foreground and --muted-foreground pass AA (>= 4.5:1) against --chrome', () => {
      expect(
        contrastRatio(get(light, '--chrome-foreground'), get(light, '--chrome')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(light, '--muted-foreground'), get(light, '--chrome')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('--nav-active-foreground passes AA (>= 4.5:1) against --nav-active', () => {
      expect(
        contrastRatio(get(light, '--nav-active-foreground'), get(light, '--nav-active')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('--brand-ink passes AA (>= 4.5:1) against --background, --card, and --chrome', () => {
      for (const surface of ['--background', '--card', '--chrome'] as const) {
        expect(
          contrastRatio(get(light, '--brand-ink'), get(light, surface)),
        ).toBeGreaterThanOrEqual(4.5)
      }
    })
  })

  describe('Dark Theme Contrast', () => {
    it('foreground text passes AA (>= 4.5:1) against background, card, and popover', () => {
      expect(
        contrastRatio(get(dark, '--foreground'), get(dark, '--background')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(dark, '--card-foreground'), get(dark, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(dark, '--popover-foreground'), get(dark, '--popover')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('primary button text passes AA (>= 4.5:1) against primary filled background', () => {
      expect(
        contrastRatio(get(dark, '--primary-foreground'), get(dark, '--primary')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('secondary and muted foregrounds pass AA (>= 4.5:1) against their backgrounds', () => {
      expect(
        contrastRatio(get(dark, '--secondary-foreground'), get(dark, '--secondary')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(dark, '--muted-foreground'), get(dark, '--background')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(dark, '--muted-foreground'), get(dark, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('destructive button text passes AA (>= 4.5:1)', () => {
      expect(
        contrastRatio(get(dark, '--destructive-foreground'), get(dark, '--destructive')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('destructive text passes AA (>= 4.5:1) against card surface', () => {
      expect(
        contrastRatio(get(dark, '--destructive-text'), get(dark, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('status colors pass AA (>= 4.5:1) against card surface', () => {
      expect(
        contrastRatio(get(dark, '--status-online'), get(dark, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(dark, '--status-pending'), get(dark, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(dark, '--status-offline'), get(dark, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(dark, '--status-alert'), get(dark, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(get(dark, '--status-live'), get(dark, '--card'))).toBeGreaterThanOrEqual(
        4.5,
      )
    })

    it('--status-online-fg passes AA (>= 4.5:1) against background and card surface', () => {
      expect(
        contrastRatio(get(dark, '--status-online-fg'), get(dark, '--background')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(dark, '--status-online-fg'), get(dark, '--card')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('--status-online-fg passes AA (>= 4.5:1) against tinted surfaces (15% and 10% over background and card)', () => {
      const fg = get(dark, '--status-online-fg')
      const tint = get(dark, '--status-online')
      for (const surfaceName of ['--background', '--card'] as const) {
        const bg = get(dark, surfaceName)
        const tint15 = compositeColor(tint, 0.15, bg)
        const tint10 = compositeColor(tint, 0.1, bg)
        expect(contrastRatio(fg, tint15)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(fg, tint10)).toBeGreaterThanOrEqual(4.5)
      }
    })

    it('--status-pending passes AA (>= 4.5:1) against tinted surfaces (15% and 10% over background and card)', () => {
      const fg = get(dark, '--status-pending')
      const tint = get(dark, '--status-pending')
      for (const surfaceName of ['--background', '--card'] as const) {
        const bg = get(dark, surfaceName)
        const tint15 = compositeColor(tint, 0.15, bg)
        const tint10 = compositeColor(tint, 0.1, bg)
        expect(contrastRatio(fg, tint15)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(fg, tint10)).toBeGreaterThanOrEqual(4.5)
      }
    })

    it('--status-pending passes AA (>= 4.5:1) against tinted surfaces (15% tint over --nav-active and --chrome)', () => {
      const fg = get(dark, '--status-pending')
      const tint = get(dark, '--status-pending')
      for (const surfaceName of ['--nav-active', '--chrome'] as const) {
        const bg = get(dark, surfaceName)
        const tint15 = compositeColor(tint, 0.15, bg)
        expect(contrastRatio(fg, tint15)).toBeGreaterThanOrEqual(4.5)
      }
    })

    it('--chrome-foreground and --muted-foreground pass AA (>= 4.5:1) against --chrome', () => {
      expect(
        contrastRatio(get(dark, '--chrome-foreground'), get(dark, '--chrome')),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(get(dark, '--muted-foreground'), get(dark, '--chrome')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('--nav-active-foreground passes AA (>= 4.5:1) against --nav-active', () => {
      expect(
        contrastRatio(get(dark, '--nav-active-foreground'), get(dark, '--nav-active')),
      ).toBeGreaterThanOrEqual(4.5)
    })

    it('--brand-ink passes AA (>= 4.5:1) against --background, --card, and --chrome', () => {
      for (const surface of ['--background', '--card', '--chrome'] as const) {
        expect(contrastRatio(get(dark, '--brand-ink'), get(dark, surface))).toBeGreaterThanOrEqual(
          4.5,
        )
      }
    })
  })
})

it('gives Ocean, Moss, and Ferricade distinct --brand-ink hues in light and dark modes', () => {
  const ferricade = extractThemeTokens('ferricade')
  const ocean = extractThemeTokens('ocean')
  const moss = extractThemeTokens('moss')
  expect(
    new Set([ferricade.light['--brand-ink'], ocean.light['--brand-ink'], moss.light['--brand-ink']])
      .size,
  ).toBe(3)
  expect(
    new Set([ferricade.dark['--brand-ink'], ocean.dark['--brand-ink'], moss.dark['--brand-ink']])
      .size,
  ).toBe(3)
})

it('defines primary text in each default Indigo theme block', () => {
  const blocks = [
    tokensRaw.match(/^:root,\s*\n\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/m)?.[1],
    tokensRaw.match(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([\s\S]*?)\n\s*\}\s*\n\}/,
    )?.[1],
    tokensRaw.match(/^\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/m)?.[1],
  ]

  expect(blocks).toHaveLength(3)
  for (const block of blocks) {
    expect(block).toMatch(/--primary-text:\s*var\(--primary\);/)
  }
})
