// The mock API for Node: Vitest tests, and Playwright's own tooling.
import { setupServer } from 'msw/node'
import type { MockConfig } from './config'
import type { MockDB } from './db'
import { handlers } from './handlers'

export function createMockServer(db: MockDB, config: MockConfig) {
  return setupServer(...handlers(db, config))
}
