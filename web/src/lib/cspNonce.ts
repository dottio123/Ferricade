// The CSP nonce for <style> elements (Ruling F5). ferricade serves index.html
// with a fresh nonce in <meta name="csp-nonce"> and the same nonce in that
// response's style-src; a <style> a library adds at runtime is applied only
// when it carries it. main.tsx hands it to get-nonce (Radix's scroll lock);
// a library with a nonce prop gets cspNonce() there.

// 16 random bytes in standard base64, as internal/adminapi/ui.go makes it. The
// placeholder of an untemplated index.html (the dev server) is not one.
const NONCE = /^[A-Za-z0-9+/]+={0,2}$/

/** The nonce in doc's <meta name="csp-nonce">, or undefined when there is none. */
export function readCspNonce(doc: Document): string | undefined {
  const content = doc.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? ''
  return NONCE.test(content) && content.length % 4 === 0 ? content : undefined
}

let page: { nonce: string | undefined } | undefined

/** This page's style nonce, read once; undefined on the dev server. */
export function cspNonce(): string | undefined {
  page ??= { nonce: readCspNonce(document) }
  return page.nonce
}
