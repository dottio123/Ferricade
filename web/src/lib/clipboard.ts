/**
 * Copies text to clipboard.
 * 1. Tries `navigator.clipboard.writeText` when available.
 * 2. Falls back to `document.execCommand('copy')` on a temporary selected element.
 * 3. Returns 'manual' if neither succeeds so caller can guide the user to press Ctrl+C.
 */
export async function copyText(text: string): Promise<'copied' | 'manual'> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text)
      return 'copied'
    } catch {
      // Fall through to execCommand
    }
  }

  if (typeof document !== 'undefined') {
    // Selecting the text needs focus; give it back afterwards so a keyboard
    // user stays on the button they pressed.
    const previous = document.activeElement
    const textarea = document.createElement('textarea')
    try {
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.top = '0'
      textarea.style.left = '0'
      textarea.style.opacity = '0'
      textarea.style.pointerEvents = 'none'
      textarea.setAttribute('readonly', '')
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      const doc = document as unknown as { execCommand?: (cmd: string) => boolean }
      const success = typeof doc.execCommand === 'function' ? doc.execCommand('copy') : false
      if (success) {
        return 'copied'
      }
    } catch {
      // Fall through to manual
    } finally {
      textarea.remove()
      if (previous instanceof HTMLElement) previous.focus()
    }
  }

  return 'manual'
}
