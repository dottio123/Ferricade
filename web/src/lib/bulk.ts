/**
 * Executes an array of asynchronous tasks with a maximum concurrency limit,
 * tracking success and failure results alongside progress notifications.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
  onProgress?: (completed: number, total: number) => void,
): Promise<{ success: { item: T; result: R }[]; failed: { item: T; error: unknown }[] }> {
  const success: { item: T; result: R }[] = []
  const failed: { item: T; error: unknown }[] = []
  let nextIndex = 0
  let completed = 0

  if (items.length === 0) {
    return { success, failed }
  }

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++
      const item = items[idx]
      if (item === undefined) continue
      try {
        const result = await task(item)
        success.push({ item, result })
      } catch (error) {
        failed.push({ item, error })
      } finally {
        completed++
        onProgress?.(completed, items.length)
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: workerCount }, () => worker())
  await Promise.all(workers)

  return { success, failed }
}
