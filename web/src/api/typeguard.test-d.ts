// Compile-time guard, checked by `npm run typecheck` (never run): calls that are
// not in internal/adminapi/openapi.yaml must not compile. If a line marked
// with the expect-error directive stops being an error, typecheck fails.
import { api, setupClient, unwrap } from './client'
import type { ApiError } from './errors'
import type { components } from './schema'

export async function typeGuards() {
  // @ts-expect-error -- undocumented path
  await api.GET('/admin/api/v1/nope')

  // @ts-expect-error -- the path exists but has no DELETE
  await api.DELETE('/admin/api/v1/auth/me')

  // @ts-expect-error -- undocumented response field
  void (await unwrap(api.GET('/admin/api/v1/auth/me'))).session_id

  await api.POST('/admin/api/v1/auth/login', {
    // @ts-expect-error -- undocumented request field
    body: { username: 'a', password: 'b', remember: true },
  })

  // @ts-expect-error -- a required request field is missing
  await api.POST('/admin/api/v1/auth/login', { body: { username: 'a' } })

  // @ts-expect-error -- undocumented query parameter
  await api.GET('/admin/api/v1/tags', { params: { query: { sort: 'name' } } })

  // @ts-expect-error -- a required path parameter is missing
  await api.DELETE('/admin/api/v1/tags/{id}')

  // @ts-expect-error -- an invented path parameter name
  await api.DELETE('/admin/api/v1/tags/{id}', { params: { path: { tag_id: 'x' } } })

  // Transport options are fixed by the client; a call passes only params, body and signal.
  const body = { name: 'x' }
  // @ts-expect-error -- no per-call baseUrl (would send the CSRF token elsewhere)
  await api.POST('/admin/api/v1/tags', { body, baseUrl: 'https://evil.example' })
  // @ts-expect-error -- no per-call credentials
  await api.POST('/admin/api/v1/tags', { body, credentials: 'include' })
  // @ts-expect-error -- no per-call headers
  await api.POST('/admin/api/v1/tags', { body, headers: { 'X-CSRF-Token': 'x' } })
  // @ts-expect-error -- no per-call fetch
  await api.POST('/admin/api/v1/tags', { body, fetch: globalThis.fetch })
  // @ts-expect-error -- no per-call middleware
  await api.POST('/admin/api/v1/tags', { body, middleware: [] })
  // @ts-expect-error -- no per-call parseAs
  await api.GET('/admin/api/v1/tags', { parseAs: 'text' })
  // @ts-expect-error -- the setup client takes no per-call headers either
  await setupClient('t').POST('/setup/complete', { headers: { 'X-Setup-Token': 'other' } })

  // @ts-expect-error -- callers cannot add or remove middleware
  api.eject()

  // @ts-expect-error -- the setup client reaches only /setup paths
  await setupClient('token').GET('/admin/api/v1/auth/me')

  // The session client has no setup wizard steps (setupClient has them): only GET /setup/status.
  // @ts-expect-error -- a wizard step through the session client
  await api.POST('/setup/owner', { body: { username: 'a', password: 'long password' } })
  // @ts-expect-error -- a wizard step through the session client
  await api.POST('/setup/complete')
  // @ts-expect-error -- not a path at all (the wizard lives under /setup, not /admin/api/v1)
  await api.POST('/admin/api/v1/setup/owner', { body: { username: 'a', password: 'b' } })
  await api.GET('/setup/status')

  // @ts-expect-error -- not an error code in the contract
  const code: ApiError['code'] = 'not_a_code'

  // Documented calls type-check, and unwrap yields the contract's types.
  const me = await unwrap(api.GET('/admin/api/v1/auth/me'))
  const user: components['schemas']['User'] = me.user
  const tags = await unwrap(
    api.GET('/admin/api/v1/tags', {
      params: { query: { limit: 10 } },
      signal: new AbortController().signal,
    }),
  )
  const tag: components['schemas']['Tag'] | undefined = tags.items[0]
  await api.DELETE('/admin/api/v1/tags/{id}', { params: { path: { id: 'x' } } })
  return { code, user, tag }
}
