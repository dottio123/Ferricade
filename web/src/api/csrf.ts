// The session's CSRF token. It lives only in this module's memory: never in
// localStorage, sessionStorage or a cookie, so a reload starts without one and
// the app gets it back from GET /auth/me.
let token = ''

export const csrf = {
  get(): string {
    return token
  },
  set(t: string): void {
    token = t
  },
  clear(): void {
    token = ''
  },
}
