// Theme and density on <html> (data-theme, data-density), which the tokens in
// src/styles key off. The user's choice lives on the server (GET/PUT
// /me/preferences); this keeps a copy in localStorage only so that
// public/theme.js can apply it before the first paint, with no flash.
// public/theme.js repeats readCachedAppearance in plain JS; appearance.test.ts
// runs it to keep the two in step.
import * as React from 'react'
import type { components } from '../api/schema'

type Preferences = components['schemas']['Preferences']
export type Theme = Preferences['theme']
export type Palette = Preferences['palette']
export type Density = Preferences['density']
export const PALETTES: readonly Palette[] = [
  'default',
  'graphite',
  'ocean',
  'violet',
  'moss',
  'sandstone',
]
export interface Appearance {
  theme: Theme
  palette: Palette
  density: Density
}

export const APPEARANCE_KEY = 'ferricade-appearance'

/** The server's defaults for a user who never chose (internal/adminapi/prefs.go). */
export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'system',
  palette: 'default',
  density: 'comfortable',
}

const THEMES: readonly Theme[] = ['dark', 'light', 'system']
const DENSITIES: readonly Density[] = ['comfortable', 'compact']

export type ResolvedMode = 'light' | 'dark'

export function useResolvedMode(theme: Theme): ResolvedMode {
  const [systemDark, setSystemDark] = React.useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false,
  )
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
}

export const THEME_COLORS: Record<Palette, Record<ResolvedMode, string>> = {
  default: { light: '#4338ca', dark: '#0f1322' },
  graphite: { light: '#18181b', dark: '#111114' },
  ocean: { light: '#0369a1', dark: '#0a1724' },
  violet: { light: '#6d28d9', dark: '#140f24' },
  moss: { light: '#3f5a2a', dark: '#131814' },
  sandstone: { light: '#54462e', dark: '#171412' },
}

let systemMediaQuery: MediaQueryList | null = null
let systemListener: ((e: MediaQueryListEvent | { matches: boolean }) => void) | null = null

/**
 * Applies theme and density to the page and caches them for the next load.
 * "system" removes data-theme, so the CSS follows prefers-color-scheme.
 */
export function applyAppearance(appearance: Appearance, root = document.documentElement): void {
  if (appearance.theme === 'system') root.removeAttribute('data-theme')
  else root.dataset.theme = appearance.theme
  if (appearance.palette === 'default') root.removeAttribute('data-palette')
  else root.dataset.palette = appearance.palette
  root.dataset.density = appearance.density

  const icon =
    typeof document !== 'undefined'
      ? document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      : null
  if (icon) {
    icon.setAttribute(
      'href',
      appearance.palette === 'default'
        ? '/icons/icon.svg'
        : `/icons/icon-${appearance.palette}.svg`,
    )
  }

  if (systemMediaQuery && systemListener) {
    if (typeof systemMediaQuery.removeEventListener === 'function') {
      systemMediaQuery.removeEventListener('change', systemListener)
    } else if (
      'removeListener' in systemMediaQuery &&
      typeof (systemMediaQuery as { removeListener?: unknown }).removeListener === 'function'
    ) {
      ;(systemMediaQuery as { removeListener: (fn: unknown) => void }).removeListener(
        systemListener,
      )
    }
    systemMediaQuery = null
    systemListener = null
  }

  const metaTheme =
    typeof document !== 'undefined'
      ? document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      : null

  const applyThemeColor = (isDark: boolean) => {
    if (!metaTheme) return
    const mode: ResolvedMode = isDark ? 'dark' : 'light'
    const colors = THEME_COLORS[appearance.palette] ?? THEME_COLORS.default
    metaTheme.setAttribute('content', colors[mode])
  }

  if (appearance.theme === 'system') {
    const mql =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null
    applyThemeColor(Boolean(mql?.matches))
    if (mql) {
      systemListener = (e: MediaQueryListEvent | { matches: boolean }) => {
        applyThemeColor(e.matches)
      }
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', systemListener)
      } else if (
        'addListener' in mql &&
        typeof (mql as { addListener?: unknown }).addListener === 'function'
      ) {
        ;(mql as { addListener: (fn: unknown) => void }).addListener(systemListener)
      }
      systemMediaQuery = mql
    }
  } else {
    applyThemeColor(appearance.theme === 'dark')
  }

  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance))
  } catch {
    // Blocked or full storage only costs a flash on the next load.
  }
}

/** The cached appearance; each invalid or missing field is the server default. */
export function readCachedAppearance(): Appearance {
  let cached: unknown
  try {
    cached = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? 'null')
  } catch {
    cached = null
  }
  const c = (typeof cached === 'object' && cached !== null ? cached : {}) as Record<string, unknown>
  return {
    theme: THEMES.includes(c.theme as Theme) ? (c.theme as Theme) : DEFAULT_APPEARANCE.theme,
    palette: PALETTES.includes(c.palette as Palette) ? (c.palette as Palette) : 'default',
    density: DENSITIES.includes(c.density as Density)
      ? (c.density as Density)
      : DEFAULT_APPEARANCE.density,
  }
}
