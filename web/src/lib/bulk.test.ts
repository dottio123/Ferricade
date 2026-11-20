import { describe, expect, it, vi } from 'vitest'
import { runWithConcurrency } from './bulk'

describe('runWithConcurrency', () => {
  it('executes tasks respecting max concurrency limit (at most 4 in flight)', async () => {
    let currentInFlight = 0
    let maxObservedInFlight = 0
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

    const task = async (item: number) => {
      currentInFlight++
      if (currentInFlight > maxObservedInFlight) {
        maxObservedInFlight = currentInFlight
      }
      // Small simulated async delay
      await new Promise((resolve) => setTimeout(resolve, 20))
      currentInFlight--
      return item * 2
    }

    const { success, failed } = await runWithConcurrency(items, 4, task)

    expect(maxObservedInFlight).toBeLessThanOrEqual(4)
    expect(maxObservedInFlight).toBeGreaterThanOrEqual(1)
    expect(success).toHaveLength(10)
    expect(failed).toHaveLength(0)
    expect(success.map((s) => s.result)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
  })

  it('collects both successful results and failures', async () => {
    const items = ['a', 'b', 'c', 'd', 'e']

    const task = async (item: string) => {
      if (item === 'b' || item === 'd') {
        throw new Error(`Failed on ${item}`)
      }
      return item.toUpperCase()
    }

    const { success, failed } = await runWithConcurrency(items, 2, task)

    expect(success.map((s) => s.item)).toEqual(['a', 'c', 'e'])
    expect(success.map((s) => s.result)).toEqual(['A', 'C', 'E'])
    expect(failed.map((f) => f.item)).toEqual(['b', 'd'])
    expect((failed[0]?.error as Error).message).toBe('Failed on b')
    expect((failed[1]?.error as Error).message).toBe('Failed on d')
  })

  it('calls onProgress with completed and total counts', async () => {
    const items = [1, 2, 3]
    const progressSpy = vi.fn()

    await runWithConcurrency(items, 2, async (n) => n, progressSpy)

    expect(progressSpy).toHaveBeenCalledTimes(3)
    expect(progressSpy).toHaveBeenNthCalledWith(1, 1, 3)
    expect(progressSpy).toHaveBeenNthCalledWith(2, 2, 3)
    expect(progressSpy).toHaveBeenNthCalledWith(3, 3, 3)
  })

  it('handles empty item array', async () => {
    const task = vi.fn()
    const { success, failed } = await runWithConcurrency([], 4, task)

    expect(task).not.toHaveBeenCalled()
    expect(success).toEqual([])
    expect(failed).toEqual([])
  })
})
