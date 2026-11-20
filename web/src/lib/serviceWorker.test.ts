import { describe, expect, it, vi } from 'vitest'
import { registerServiceWorker } from './serviceWorker'

describe('registerServiceWorker', () => {
  it('registers the app service worker at the root scope', async () => {
    const register = vi.fn().mockResolvedValue({} as ServiceWorkerRegistration)
    await registerServiceWorker({ register } as unknown as ServiceWorkerContainer)
    expect(register).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
  })

  it('warns and resolves when registration fails', async () => {
    const error = new Error('blocked')
    const register = vi.fn().mockRejectedValue(error)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      registerServiceWorker({ register } as unknown as ServiceWorkerContainer),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('service worker registration failed', error)
    warn.mockRestore()
  })

  it('does nothing without a service worker container', async () => {
    await expect(registerServiceWorker(undefined)).resolves.toBeUndefined()
  })
})
