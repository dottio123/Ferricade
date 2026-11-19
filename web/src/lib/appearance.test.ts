import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  APPEARANCE_KEY,
  DEFAULT_APPEARANCE,
  PALETTES,
  THEME_COLORS,
  applyAppearance,
  readCachedAppearance,
  type Appearance,
} from './appearance'
import script from '../../public/theme.js?raw'

const root = document.documentElement

beforeEach(() => {
  document.head.innerHTML = `
    <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
    <meta name="theme-color" content="#4338ca" />
  `
})

afterEach(() => {
  localStorage.clear()
  root.removeAttribute('data-theme')
  root.removeAttribute('data-palette')
  root.removeAttribute('data-density')
  document.head.innerHTML = ''
})

describe('applyAppearance', () => {
  it('sets data-theme and data-density on <html> and caches them', () => {
    applyAppearance({ theme: 'light', palette: 'ocean', density: 'compact' })
    expect(root.dataset.theme).toBe('light')
    expect(root.dataset.density).toBe('compact')
    expect(root.dataset.palette).toBe('ocean')
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!)).toEqual({
      theme: 'light',
      palette: 'ocean',
      density: 'compact',
    })
  })

  it('leaves the theme to prefers-color-scheme for "system"', () => {
    applyAppearance({ theme: 'dark', palette: 'ocean', density: 'comfortable' })
    applyAppearance({ theme: 'system', palette: 'default', density: 'comfortable' })
    expect(root.hasAttribute('data-theme')).toBe(false)
    expect(root.dataset.density).toBe('comfortable')
    expect(root.hasAttribute('data-palette')).toBe(false)
  })

  it('still applies when storage throws (blocked or full)', () => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    try {
      applyAppearance({ theme: 'dark', palette: 'default', density: 'compact' })
    } finally {
      Storage.prototype.setItem = setItem
    }
    expect(root.dataset.theme).toBe('dark')
    expect(root.hasAttribute('data-palette')).toBe(false)
  })
})

describe('readCachedAppearance', () => {
  it('is the server default when nothing is cached', () => {
    expect(readCachedAppearance()).toEqual(DEFAULT_APPEARANCE)
    expect(DEFAULT_APPEARANCE).toEqual({
      theme: 'system',
      palette: 'default',
      density: 'comfortable',
    })
  })

  it('reads what applyAppearance cached', () => {
    applyAppearance({ theme: 'dark', palette: 'ocean', density: 'compact' })
    expect(readCachedAppearance()).toEqual({ theme: 'dark', palette: 'ocean', density: 'compact' })
  })

  it.each([
    ['not json', '{'],
    ['an unknown theme', '{"theme":"neon","palette":"ocean","density":"compact"}'],
    ['an unknown density', '{"theme":"dark","palette":"ocean","density":"cozy"}'],
    ['a non-object', '"dark"'],
  ])('falls back field by field on %s', (_, raw) => {
    localStorage.setItem(APPEARANCE_KEY, raw)
    const got = readCachedAppearance()
    expect(['dark', 'light', 'system']).toContain(got.theme)
    expect(['comfortable', 'compact']).toContain(got.density)
    expect(PALETTES).toContain(got.palette)
  })

  it('keeps the valid field when the other is invalid', () => {
    localStorage.setItem(APPEARANCE_KEY, '{"theme":"light","palette":"neon","density":"cozy"}')
    expect(readCachedAppearance()).toEqual({
      theme: 'light',
      palette: 'default',
      density: 'comfortable',
    })
  })

  it.each([
    ['old cache without palette', '{"theme":"dark","density":"compact"}'],
    ['invalid palette', '{"theme":"dark","palette":"neon","density":"compact"}'],
  ])('defaults %s while keeping the other fields', (_, raw) => {
    localStorage.setItem(APPEARANCE_KEY, raw)
    expect(readCachedAppearance()).toEqual({
      theme: 'dark',
      palette: 'default',
      density: 'compact',
    })
  })

  it('accepts a cached Moss palette', () => {
    localStorage.setItem(APPEARANCE_KEY, '{"theme":"dark","palette":"moss","density":"compact"}')
    expect(readCachedAppearance()).toEqual({ theme: 'dark', palette: 'moss', density: 'compact' })
  })
})

// public/theme.js runs before the app (a plain script, no imports), so it
// repeats appearance.ts's reading. Run the real file and compare.
describe('public/theme.js', () => {
  const runThemeScript = () => new Function(script)()

  it.each<Appearance>([
    { theme: 'dark', palette: 'violet', density: 'compact' },
    { theme: 'light', palette: 'default', density: 'comfortable' },
    { theme: 'system', palette: 'ocean', density: 'compact' },
    { theme: 'dark', palette: 'moss', density: 'comfortable' },
  ])('applies what applyAppearance cached: %o', (appearance) => {
    applyAppearance(appearance)
    root.removeAttribute('data-theme')
    root.removeAttribute('data-density')
    root.removeAttribute('data-palette')

    runThemeScript()
    expect(root.getAttribute('data-theme')).toBe(
      appearance.theme === 'system' ? null : appearance.theme,
    )
    expect(root.dataset.density).toBe(appearance.density)
    expect(root.dataset.palette).toBe(
      appearance.palette === 'default' ? undefined : appearance.palette,
    )
  })

  it('ignores an invalid cache and never throws', () => {
    localStorage.setItem(APPEARANCE_KEY, '{"theme":"<img>","palette":"neon","density":42}')
    expect(runThemeScript).not.toThrow()
    expect(root.hasAttribute('data-theme')).toBe(false)
    expect(root.dataset.density).toBe('comfortable')
    expect(root.hasAttribute('data-palette')).toBe(false)
  })

  it('survives storage that throws', () => {
    const getItem = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    try {
      expect(runThemeScript).not.toThrow()
    } finally {
      Storage.prototype.getItem = getItem
    }
    expect(root.dataset.density).toBe('comfortable')
  })

  it.each<Appearance>([
    { theme: 'dark', palette: 'violet', density: 'compact' },
    { theme: 'light', palette: 'default', density: 'comfortable' },
    { theme: 'system', palette: 'ocean', density: 'compact' },
    { theme: 'dark', palette: 'moss', density: 'comfortable' },
    { theme: 'light', palette: 'sandstone', density: 'comfortable' },
    { theme: 'dark', palette: 'graphite', density: 'compact' },
  ])('theme.js sets icon href and theme-color matching applyAppearance: %o', (appearance) => {
    applyAppearance(appearance)
    const expectedIcon = document.querySelector('link[rel="icon"]')?.getAttribute('href')
    const expectedColor = document
      .querySelector('meta[name="theme-color"]')
      ?.getAttribute('content')

    // Reset DOM head & attributes to defaults before running theme.js
    document.head.innerHTML = `
      <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
      <meta name="theme-color" content="#4338ca" />
    `
    root.removeAttribute('data-theme')
    root.removeAttribute('data-density')
    root.removeAttribute('data-palette')

    runThemeScript()

    const actualIcon = document.querySelector('link[rel="icon"]')?.getAttribute('href')
    const actualColor = document.querySelector('meta[name="theme-color"]')?.getAttribute('content')
    expect(actualIcon).toBe(expectedIcon)
    expect(actualColor).toBe(expectedColor)
  })

  it('theme.js resolves system to dark when prefers-color-scheme: dark matches', () => {
    const origMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('dark'),
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia

    try {
      applyAppearance({ theme: 'system', palette: 'sandstone', density: 'comfortable' })
      expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
        THEME_COLORS.sandstone.dark,
      )

      document.head.innerHTML = `
        <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
        <meta name="theme-color" content="#4338ca" />
      `
      root.removeAttribute('data-theme')
      root.removeAttribute('data-density')
      root.removeAttribute('data-palette')

      runThemeScript()

      expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
        THEME_COLORS.sandstone.dark,
      )
      expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe(
        '/icons/icon-sandstone.svg',
      )
    } finally {
      window.matchMedia = origMatchMedia
    }
  })
})

describe('applyAppearance: icon and theme-color', () => {
  it.each(PALETTES)('sets the expected icon href for palette "%s"', (palette) => {
    applyAppearance({ theme: 'light', palette, density: 'comfortable' })
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    const expectedHref = palette === 'default' ? '/icons/icon.svg' : `/icons/icon-${palette}.svg`
    expect(icon?.getAttribute('href')).toBe(expectedHref)
  })

  it.each(
    PALETTES.flatMap((palette) => [
      { palette, theme: 'light' as const },
      { palette, theme: 'dark' as const },
    ]),
  )('sets theme-color for palette "$palette" and theme "$theme"', ({ palette, theme }) => {
    applyAppearance({ theme, palette, density: 'comfortable' })
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    expect(meta?.getAttribute('content')).toBe(THEME_COLORS[palette][theme])
  })

  it('follows matchMedia for "system" and updates on its change event', () => {
    const handlers: Array<(e: { matches: boolean }) => void> = []
    const mql = {
      matches: false,
      addEventListener: (_event: string, handler: (e: { matches: boolean }) => void) => {
        handlers.push(handler)
      },
      removeEventListener: (_event: string, handler: (e: { matches: boolean }) => void) => {
        const idx = handlers.indexOf(handler)
        if (idx >= 0) handlers.splice(idx, 1)
      },
    }
    const origMatchMedia = window.matchMedia
    window.matchMedia = (() => mql) as unknown as typeof window.matchMedia

    try {
      applyAppearance({ theme: 'system', palette: 'sandstone', density: 'comfortable' })
      const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      expect(meta?.getAttribute('content')).toBe(THEME_COLORS.sandstone.light)

      // Simulate OS switching to dark
      mql.matches = true
      for (const h of handlers) h({ matches: true })
      expect(meta?.getAttribute('content')).toBe(THEME_COLORS.sandstone.dark)

      // Switching to explicit light theme detaches or ignores system change
      applyAppearance({ theme: 'light', palette: 'sandstone', density: 'comfortable' })
      expect(meta?.getAttribute('content')).toBe(THEME_COLORS.sandstone.light)

      mql.matches = true
      for (const h of handlers) h({ matches: true })
      expect(meta?.getAttribute('content')).toBe(THEME_COLORS.sandstone.light)
    } finally {
      window.matchMedia = origMatchMedia
    }
  })
})

describe('icon files', () => {
  it.each(PALETTES)('public/icons has an icon file for palette "%s"', (palette) => {
    const filename = palette === 'default' ? 'icon.svg' : `icon-${palette}.svg`
    const iconPath = path.resolve(__dirname, '../../public/icons', filename)
    expect(fs.existsSync(iconPath)).toBe(true)
  })
})
