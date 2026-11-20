import { DAY, type Rng } from './rng'
import type { Snapshot } from './types'

export const SNAPSHOT_STEP = 5 * 60_000
export const SNAPSHOT_DAYS = 90

/**
 * 90 days of five-minute snapshots ending in the slot that contains `now`. The
 * last one equals the current counts, so the trend lines meet the live numbers.
 */
export function createSnapshots(
  rng: Rng,
  now: number,
  current: { approved: number; online: number; pending: number; sessions: number },
): Snapshot[] {
  const n = (SNAPSHOT_DAYS * DAY) / SNAPSHOT_STEP
  const last = Math.floor(now / SNAPSHOT_STEP) * SNAPSHOT_STEP
  const out: Snapshot[] = []
  const peak = current.online / Math.max(current.approved, 1)
  for (let i = 0; i < n; i++) {
    const at = last - (n - 1 - i) * SNAPSHOT_STEP
    if (i === n - 1) {
      out.push({ at, ...current })
      break
    }
    const d = new Date(at)
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6
    // Office hours lift the online share; the fleet also grows a little over the 90 days.
    const day = Math.max(0, Math.sin(((hour - 6) / 14) * Math.PI)) * (weekend ? 0.4 : 1)
    const share = Math.min(1, Math.max(0, peak * (0.55 + 0.45 * day) + (rng.next() - 0.5) * 0.06))
    const approved = Math.max(
      1,
      Math.round(current.approved * (0.82 + 0.18 * (i / n))) - (i % 2000 > 1990 ? 1 : 0),
    )
    out.push({
      at,
      approved,
      online: Math.round(approved * share),
      pending: Math.max(0, Math.round(current.pending * (0.5 + rng.next()))),
      sessions: Math.round(approved * share * 0.18 * day * (0.5 + rng.next())),
    })
  }
  return out
}
