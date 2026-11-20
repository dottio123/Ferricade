// One MSW handler for every operation of internal/adminapi/openapi.yaml,
// backed by a MockDB. handlers.test.ts fails when an operation is missing and
// validates every response against the contract.
import type { HttpHandler } from 'msw'
import { readMockConfig, type MockConfig } from './config'
import type { MockDB } from './db'
import { createEnv, type Env } from './route'
import { authRoutes } from './routes/auth'
import { deviceRoutes } from './routes/devices'
import { deploymentRoutes } from './routes/deployment'
import { eventsRoutes } from './routes/events'
import { groupRoutes, tagRoutes } from './routes/orgs'
import { groupRuleRoutes } from './routes/groupRules'
import { idAllowListRoutes } from './routes/idAllowLists'
import { policyRoutes } from './routes/policies'
import { reportRoutes } from './routes/reports'
import { settingsRoutes } from './routes/settings'
import { setupRoutes } from './routes/setup'
import { serverRoutes, userRoutes } from './routes/users'

/**
 * The handlers for one mock: its own signed-in session, and the DB it reads and
 * changes. With config.setupIncomplete the DB is put into the state of a fresh
 * install (no users, no server) first.
 */
export function handlers(db: MockDB, config: MockConfig = readMockConfig('')): HttpHandler[] {
  return createMockApi(db, config).handlers
}

/** The handlers and their Env (the session and streams), for controls.ts. */
export function createMockApi(
  db: MockDB,
  config: MockConfig = readMockConfig(''),
): { handlers: HttpHandler[]; env: Env } {
  if (config.setupIncomplete) db.beginSetup()
  const env = createEnv(db, config)
  return { env, handlers: routesFor(env) }
}

function routesFor(env: Env): HttpHandler[] {
  return [
    ...authRoutes(env),
    ...setupRoutes(env),
    ...deviceRoutes(env),
    ...deploymentRoutes(env),
    ...policyRoutes(env),
    ...groupRoutes(env),
    ...groupRuleRoutes(env),
    ...idAllowListRoutes(env),
    ...tagRoutes(env),
    ...userRoutes(env),
    ...serverRoutes(env),
    ...reportRoutes(env),
    ...settingsRoutes(env),
    ...eventsRoutes(env),
  ]
}
