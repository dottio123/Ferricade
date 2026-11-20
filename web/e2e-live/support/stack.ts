// The live stack: ferricade and Postgres from deploy/compose.dev.yml, run as the
// Compose project ferricade-e2e with e2e-live/compose.e2e.yml on top.
// e2e-live/run.ts starts and removes it; the specs read its log and run rdsim
// inside the app container (the image ships rdsim next to ferricade).
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')

export const ADMIN_URL = 'http://localhost:21220'

const COMPOSE = [
  'compose',
  '-p',
  'ferricade-e2e',
  '--env-file',
  path.join(here, '../e2e.env'),
  '-f',
  path.join(repo, 'deploy/compose.dev.yml'),
  '-f',
  path.join(here, '../compose.e2e.yml'),
]

// Compose checks every ${VAR:?} on every command, so commands that do not
// create containers (logs, exec, down) need some SECRET_KEY too. run.ts sets
// the real one before `up`.
function env(): NodeJS.ProcessEnv {
  return { ...process.env, SECRET_KEY: process.env.SECRET_KEY ?? 'not-used-by-this-command' }
}

export function composeArgs(args: string[]): string[] {
  return [...COMPOSE, ...args]
}

export function compose(args: string[]): string {
  return execFileSync('docker', composeArgs(args), { encoding: 'utf8', env: env() })
}

/** The setup token ferricade logged at startup (text or JSON log line). */
export function setupToken(): string {
  const log = compose(['logs', '--no-color', '--no-log-prefix', 'app'])
  let token = ''
  for (const line of log.split('\n')) {
    const m = /setup token: ([^\s"\\]+)/.exec(line)
    if (m) token = m[1]!
  }
  if (!token) throw new Error('no "setup token" line in the ferricade log')
  return token
}

/**
 * Runs rdsim in the app container against the client API there. Device IDs
 * start at 100000000; hostnames are sim-<id>. It stops by itself after
 * `duration`; the returned function stops it sooner.
 */
export function startRdsim(flags: string[], duration = '3m'): () => void {
  const child = spawn(
    'docker',
    composeArgs([
      'exec',
      '-T',
      'app',
      '/usr/local/bin/rdsim',
      '-api',
      'http://127.0.0.1:21114',
      '-duration',
      duration,
      ...flags,
    ]),
    { env: env(), stdio: 'ignore' },
  )
  return () => {
    child.kill()
  }
}
