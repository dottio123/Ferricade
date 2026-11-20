export const INTRO_FLAG_KEY = 'ferricade.intro.pending'

/** Marks that a sign-in attempt just started so the shell plays the intro once on arrival. */
export function setIntroFlag(): void {
  try {
    window.sessionStorage.setItem(INTRO_FLAG_KEY, '1')
  } catch {
    // Storage may be unavailable in private browsing or restricted contexts.
  }
}

/** Reads whether the post-sign-in intro should play on the next shell mount. */
export function readIntroFlag(): boolean {
  try {
    return window.sessionStorage.getItem(INTRO_FLAG_KEY) === '1'
  } catch {
    return false
  }
}

/** Clears the pending intro flag so reloads and return visits to sign-in do not play it. */
export function clearIntroFlag(): void {
  try {
    window.sessionStorage.removeItem(INTRO_FLAG_KEY)
  } catch {
    // Storage may be unavailable in private browsing or restricted contexts.
  }
}
