import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCspNonce } from './cspNonce'

function withMeta(content: string | null): Document {
  const doc = document.implementation.createHTMLDocument('t')
  if (content !== null) {
    const meta = doc.createElement('meta')
    meta.name = 'csp-nonce'
    meta.content = content
    doc.head.append(meta)
  }
  return doc
}

describe('readCspNonce', () => {
  it('returns the nonce ferricade put in <meta name="csp-nonce">', () => {
    expect(readCspNonce(withMeta('q8hY0bFz3k+1/Xv7aWm2Tg=='))).toBe('q8hY0bFz3k+1/Xv7aWm2Tg==')
  })

  it('returns undefined without the meta', () => {
    expect(readCspNonce(withMeta(null))).toBeUndefined()
  })

  it('returns undefined for the placeholder no server replaced (the dev server)', () => {
    expect(readCspNonce(withMeta('__FERRICADE_CSP_NONCE__'))).toBeUndefined()
  })

  it.each(['', ' ', "abc' 'unsafe-inline", 'abc def', 'abc==='])(
    'returns undefined for %j, which is no base64 nonce',
    (content) => {
      expect(readCspNonce(withMeta(content))).toBeUndefined()
    },
  )
})

describe('cspNonce', () => {
  afterEach(() => {
    document.head.querySelector('meta[name="csp-nonce"]')?.remove()
    vi.resetModules()
  })

  it('reads the page meta once', async () => {
    const meta = document.createElement('meta')
    meta.name = 'csp-nonce'
    meta.content = 'AAAAAAAAAAAAAAAAAAAAAA=='
    document.head.append(meta)
    const { cspNonce } = await import('./cspNonce')
    expect(cspNonce()).toBe('AAAAAAAAAAAAAAAAAAAAAA==')
    meta.content = 'BBBBBBBBBBBBBBBBBBBBBB=='
    expect(cspNonce()).toBe('AAAAAAAAAAAAAAAAAAAAAA==')
  })

  it('is undefined on a page without the meta', async () => {
    const { cspNonce } = await import('./cspNonce')
    expect(cspNonce()).toBeUndefined()
  })
})
