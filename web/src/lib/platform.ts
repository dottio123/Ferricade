/**
 * Detects whether the current platform is macOS to display the appropriate keyboard shortcut.
 * Uses navigator.userAgentData?.platform first, with a fallback to navigator.userAgent.
 */
export function getPlatformKeyHint(): string {
  if (typeof window === 'undefined') return 'Ctrl K'

  const nav = window.navigator as {
    userAgentData?: { platform?: string }
    userAgent?: string
  }

  const platform = nav.userAgentData?.platform?.toLowerCase() ?? nav.userAgent?.toLowerCase() ?? ''

  return platform.includes('mac') ? '⌘K' : 'Ctrl K'
}
