/**
 * Converts an unsigned 32-bit ARGB integer (e.g. 4280391411 = 0xFF2196F3)
 * into a CSS color string (#rrggbb or rgba(r, g, b, a)).
 */
export function toCss(argb: number): string {
  const u32 = argb >>> 0
  const a = (u32 >>> 24) & 0xff
  const r = (u32 >>> 16) & 0xff
  const g = (u32 >>> 8) & 0xff
  const b = u32 & 0xff

  if (a === 255) {
    const hex = (n: number) => n.toString(16).padStart(2, '0')
    return `#${hex(r)}${hex(g)}${hex(b)}`
  }

  const alpha = +(a / 255).toFixed(3)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Calculates a readable text color ('black' or 'white') to contrast
 * against the provided ARGB background color using WCAG relative luminance.
 */
export function textColorFor(argb: number, background = 0xffffffff): 'black' | 'white' {
  return textColorForOn(argb, background)
}

/** Returns the resolved page background as an opaque ARGB color. */
export function pageBackgroundColor(): number {
  const background =
    typeof document === 'undefined'
      ? ''
      : getComputedStyle(document.documentElement).getPropertyValue('--background').trim()
  return background ? fromCss(background) : 0xffffffff
}

/** Chooses the better contrasting text color after alpha-compositing the tag. */
function textColorForOn(argb: number, background: number): 'black' | 'white' {
  const u32 = argb >>> 0
  const ground = background >>> 0
  const alpha = ((u32 >>> 24) & 0xff) / 255
  const r = (u32 >>> 16) & 0xff
  const g = (u32 >>> 8) & 0xff
  const b = u32 & 0xff
  const shownR = r * alpha + ((ground >>> 16) & 0xff) * (1 - alpha)
  const shownG = g * alpha + ((ground >>> 8) & 0xff) * (1 - alpha)
  const shownB = b * alpha + (ground & 0xff) * (1 - alpha)

  const toLinear = (c: number) => {
    const normalized = c / 255
    return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
  }

  const lum = 0.2126 * toLinear(shownR) + 0.7152 * toLinear(shownG) + 0.0722 * toLinear(shownB)
  const blackContrast = (lum + 0.05) / 0.05
  const whiteContrast = 1.05 / (lum + 0.05)

  return blackContrast >= whiteContrast ? 'black' : 'white'
}

/**
 * Converts a hex CSS color string (#rrggbb or #rgb) into an unsigned 32-bit ARGB integer.
 * Assumes full opacity (alpha = 0xFF).
 * e.g. fromCss("#2196f3") -> 4280391411 (0xFF2196F3 >>> 0).
 */
export function fromCss(hex: string): number {
  let clean = hex.trim().replace(/^#/, '')
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (clean.length !== 6) {
    return 0
  }
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return 0
  }
  return ((0xff << 24) | (r << 16) | (g << 8) | b) >>> 0
}
