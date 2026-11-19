// Applies the cached theme, palette and density before the first paint (no flash).
// A plain script, not bundled: the CSP allows it because it is a file of this
// origin, never inline. It mirrors readCachedAppearance in
// src/lib/appearance.ts; src/lib/appearance.test.ts runs this file to keep
// the two in step.
;(function () {
  var cached
  try {
    cached = JSON.parse(localStorage.getItem('ferricade-appearance') || 'null')
  } catch {
    cached = null
  }
  if (typeof cached !== 'object' || cached === null) cached = {}
  var theme = ['dark', 'light', 'system'].indexOf(cached.theme) >= 0 ? cached.theme : 'system'
  var palette =
    ['default', 'graphite', 'ocean', 'violet', 'moss', 'sandstone'].indexOf(cached.palette) >= 0
      ? cached.palette
      : 'default'
  var density =
    ['comfortable', 'compact'].indexOf(cached.density) >= 0 ? cached.density : 'comfortable'
  var root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  if (palette === 'default') root.removeAttribute('data-palette')
  else root.setAttribute('data-palette', palette)
  root.setAttribute('data-density', density)

  var icon = document.querySelector('link[rel="icon"]')
  if (icon) {
    icon.setAttribute(
      'href',
      palette === 'default' ? '/icons/icon.svg' : '/icons/icon-' + palette + '.svg',
    )
  }

  var metaTheme = document.querySelector('meta[name="theme-color"]')
  if (metaTheme) {
    var isDark =
      theme === 'dark' ||
      (theme === 'system' &&
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    var mode = isDark ? 'dark' : 'light'
    var themeColors = {
      default: { light: '#4338ca', dark: '#0f1322' },
      graphite: { light: '#18181b', dark: '#111114' },
      ocean: { light: '#0369a1', dark: '#0a1724' },
      violet: { light: '#6d28d9', dark: '#140f24' },
      moss: { light: '#3f5a2a', dark: '#131814' },
      sandstone: { light: '#54462e', dark: '#171412' },
    }
    if (themeColors[palette]) {
      metaTheme.setAttribute('content', themeColors[palette][mode])
    }
  }
})()
