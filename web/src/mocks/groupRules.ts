// Same whole-hostname wildcard semantics as internal/grouprules.
export function matchHostname(pattern: string, name: string): boolean {
  if (!name || new TextEncoder().encode(name).length > 255) return false
  const fold = (value: string) => Array.from(value.replace(/[A-Z]/g, (c) => c.toLowerCase()))
  const p = fold(pattern),
    n = fold(name)
  let i = 0,
    j = 0,
    star = -1,
    retry = 0
  while (j < n.length) {
    if (p[i] === '*') {
      star = i++
      retry = j
    } else if (p[i] === '?' || p[i] === n[j]) {
      i++
      j++
    } else if (star >= 0) {
      i = star + 1
      j = ++retry
    } else return false
  }
  while (p[i] === '*') i++
  return i === p.length
}

export const validPattern = (pattern: string) =>
  pattern.length >= 1 && pattern.length <= 128 && !/[^A-Za-z0-9._*?-]/.test(pattern)
