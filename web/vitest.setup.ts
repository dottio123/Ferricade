import '@testing-library/jest-dom/vitest'

// MSW replaces fetch when a test starts its server. Its passthrough path calls
// the fetch it replaced; fail there so no unit test can contact a real server.
globalThis.fetch = async () => {
  throw new Error('Unmocked network request')
}

// The app calls the API with same-origin relative URLs. Browsers resolve those
// against the page URL; Node's Request (which Vitest's jsdom environment keeps)
// throws on them instead. Resolve them against jsdom's page URL, as a browser would.
const NodeRequest = globalThis.Request
globalThis.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, globalThis.location.href) : input, init)
  }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
