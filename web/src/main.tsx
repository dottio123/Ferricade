import { setNonce } from 'get-nonce'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installSessionHandlers } from './auth/unauthorized'
import { cspNonce } from './lib/cspNonce'
import { createQueryClient } from './lib/queryClient'
import { createAppRouter } from './router'
import { registerServiceWorker } from './lib/serviceWorker'
import './styles/index.css'

// The mock API (MSW) is for development and tests only. Both conditions are
// build-time constants, so the production build drops this import and contains no
// mock code (scripts/check-dist.mjs fails the build if it does).
async function startMocks(): Promise<void> {
  if (import.meta.env.MODE === 'mock' || (import.meta.env.DEV && import.meta.env.MODE !== 'live')) {
    const { startMockWorker } = await import('./mocks/browser')
    await startMockWorker(globalThis.location.search)
  }
}

// The <style> elements Radix adds at runtime (its scroll lock, through
// react-style-singleton) carry the page's CSP nonce, or the CSP blocks them
// (Ruling F5). Set before anything renders.
const nonce = cspNonce()
if (nonce) setNonce(nonce)

const queryClient = createQueryClient()
const router = createAppRouter(queryClient)
// A 401 from any API call sends the user to sign-in; a 403 "csrf" fetches a
// fresh token (src/auth/unauthorized.ts).
installSessionHandlers(router, queryClient)

void startMocks().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App router={router} queryClient={queryClient} />
    </StrictMode>,
  )
  if (import.meta.env.PROD && import.meta.env.MODE !== 'mock') void registerServiceWorker()
})
