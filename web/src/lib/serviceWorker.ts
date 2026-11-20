export function registerServiceWorker(
  container: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker,
): Promise<void> {
  if (container === undefined) return Promise.resolve()
  return container.register('/sw.js', { scope: '/' }).then(
    () => undefined,
    (error: unknown) => {
      console.warn('service worker registration failed', error)
    },
  )
}
