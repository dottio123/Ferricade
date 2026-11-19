// The mock's behaviour switches. In the browser they come from the page URL
// (?mock=, ?mock-delay=, ?mock-fail=, ?mock-role=, ?mock-grants=, ?mock-setup=, ?mock-session=); tests call
// readMockConfig with a query string directly.

export type MockSize = 'small' | 'medium' | 'large'
export type MockRole = 'owner' | 'admin' | 'user'
/** How the session starts: signed in (default), signed out, or before TOTP (passing it, or enrolling). */
export type MockSessionStart = 'signed-in' | 'signed-out' | 'mfa' | 'enroll' | 'optional'

export interface MockConfig {
  /** How many devices, sessions and audit entries the mock starts with. */
  size: MockSize
  /** Added to every response. */
  delayMs: number
  /** Operation ids (see operations.ts) that answer 500 "internal". */
  failOperations: ReadonlySet<string>
  /** Who is signed in. */
  role: MockRole
  /** With role 'user': the helpdesk account starts with its fixture grants, or with none. */
  grants: 'default' | 'none'
  /** First-run setup has not been done: /setup/status is false and the wizard works. */
  setupIncomplete: boolean
  /** The session the mock starts with. */
  session: MockSessionStart
  oidc: boolean
}

export function readMockConfig(search: string): MockConfig {
  const q = new URLSearchParams(search)
  const size = q.get('mock')
  const delay = Number(q.get('mock-delay'))
  return {
    size: size === 'small' || size === 'large' ? size : 'medium',
    delayMs: Number.isFinite(delay) && delay > 0 ? Math.min(delay, 30_000) : 0,
    failOperations: new Set(
      (q.get('mock-fail') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    role: mockRole(q.get('mock-role')),
    grants: q.get('mock-grants') === 'none' ? 'none' : 'default',
    setupIncomplete: q.get('mock-setup') === 'incomplete',
    session: sessionStart(q.get('mock-session')),
    oidc: q.get('mock-oidc') === 'on',
  }
}

function mockRole(value: string | null): MockRole {
  return value === 'admin' || value === 'user' ? value : 'owner'
}

function sessionStart(value: string | null): MockSessionStart {
  return value === 'signed-out' || value === 'mfa' || value === 'enroll' || value === 'optional'
    ? value
    : 'signed-in'
}

/** The credentials the mock accepts. Documented in README.md. */
export const DEMO = {
  password: 'correct horse battery',
  totpCode: '123456',
  /** Right code shape, but "already used": shows the code_already_used error. */
  usedTotpCode: '000000',
  setupToken: 'mock-setup-token',
  totpSecret: 'JBSWY3DPEHPK3PXP',
} as const
