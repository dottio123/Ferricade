// Deterministic data: the same size always gives the same fleet, so screenshots
// and tests are stable. mulberry32 is a small seeded PRNG.

export function createRng(seed: number) {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    chance: (p: number) => next() < p,
    /** A version-4 shaped UUID. */
    uuid(): string {
      const h = (n: number) =>
        Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join('')
      return `${h(8)}-${h(4)}-4${h(3)}-${'89ab'[Math.floor(next() * 4)]}${h(3)}-${h(12)}`
    },
  }
}
export type Rng = ReturnType<typeof createRng>

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const iso = (ms: number): string => new Date(ms).toISOString()
