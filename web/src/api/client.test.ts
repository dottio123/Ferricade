import { delay, http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  CSRF_TOKEN_PATHS,
  setCsrfRejectedHandler,
  setSecondFactorRequiredHandler,
  setUnauthorizedHandler,
  setupClient,
  unwrap,
} from './client'
import { csrf } from './csrf'
import { ApiError } from './errors'
import type { components } from './schema'

const V1 = '/admin/api/v1'
const server = setupServer()

const user = {
  id: '6f1c2c43-5f0e-4bd4-9a51-2f0b6f3f6a10',
  username: 'owner',
  display_name: 'Owner',
  email: 'owner@example.com',
  role: 'owner',
  status: 'active',
  totp_required: true,
  sso: false,
  avatar_url: null,
}
const tag = { id: '0b8f0c1e-3a6b-4f53-8a57-9a8d5a0c2f11', name: 'office', color: 4280391411 }
const prefs: components['schemas']['Preferences'] = {
  preset: 'business',
  modules: [],
  pinned_device_ids: [],
  theme: 'system',
  palette: 'ferricade',
  density: 'comfortable',
  toast_seconds: 5,
}
const error = (status: number, code: string, message: string, extra = {}) =>
  HttpResponse.json({ error: { code, message, ...extra } }, { status })

// Records the X-CSRF-Token header (or null) of every request that reaches the server.
let seenCsrf: Record<string, string | null>
const record = (request: Request) => {
  seenCsrf[`${request.method} ${new URL(request.url).pathname}`] =
    request.headers.get('X-CSRF-Token')
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => {
  seenCsrf = {}
  csrf.clear()
  setUnauthorizedHandler(() => {})
  setCsrfRejectedHandler(() => {})
  setSecondFactorRequiredHandler(() => {})
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('CSRF header', () => {
  beforeEach(() => {
    server.use(
      http.all(`${V1}/tags`, ({ request }) => {
        record(request)
        return HttpResponse.json(
          request.method === 'GET' ? { items: [tag], next_cursor: '' } : tag,
          { status: request.method === 'POST' ? 201 : 200 },
        )
      }),
      http.all(`${V1}/tags/:id`, ({ request }) => {
        record(request)
        return request.method === 'DELETE'
          ? new HttpResponse(null, { status: 204 })
          : HttpResponse.json(tag)
      }),
      http.put(`${V1}/me/preferences`, ({ request }) => {
        record(request)
        return HttpResponse.json(prefs)
      }),
    )
  })

  it('goes on POST, PUT, PATCH and DELETE but not on GET', async () => {
    csrf.set('tok-1')
    const id = { params: { path: { id: tag.id } } }
    await api.GET(`${V1}/tags`)
    await api.POST(`${V1}/tags`, { body: { name: 'office' } })
    await api.PUT(`${V1}/me/preferences`, { body: prefs })
    await api.PATCH(`${V1}/tags/{id}`, { ...id, body: { name: 'lab' } })
    await api.DELETE(`${V1}/tags/{id}`, id)

    expect(seenCsrf).toEqual({
      [`GET ${V1}/tags`]: null,
      [`POST ${V1}/tags`]: 'tok-1',
      [`PUT ${V1}/me/preferences`]: 'tok-1',
      [`PATCH ${V1}/tags/${tag.id}`]: 'tok-1',
      [`DELETE ${V1}/tags/${tag.id}`]: 'tok-1',
    })
  })

  it('is not sent before there is a token', async () => {
    await api.POST(`${V1}/tags`, { body: { name: 'office' } })
    expect(seenCsrf[`POST ${V1}/tags`]).toBeNull()
  })
})

describe('same-origin only', () => {
  it('sends credentials same-origin', async () => {
    let credentials: RequestCredentials | undefined
    server.use(
      http.get(`${V1}/tags`, ({ request }) => {
        credentials = request.credentials
        return HttpResponse.json({ items: [], next_cursor: '' })
      }),
    )
    await api.GET(`${V1}/tags`)
    expect(credentials).toBe('same-origin')
  })

  it.each([
    ['api', () => api],
    ['setupClient', () => setupClient('setup-secret')],
  ])('%s refuses a request to another origin without sending it', async (_, client) => {
    const sent = vi.fn()
    server.use(
      http.all('https://evil.example/*', ({ request }) => {
        sent(request.headers.get('X-CSRF-Token'), request.headers.get('X-Setup-Token'))
        return HttpResponse.json({})
      }),
    )
    csrf.set('session-token')
    // The types forbid a per-call baseUrl; this checks the runtime guard behind them.
    const call = client().POST as unknown as (
      url: string,
      init: { baseUrl: string; body?: unknown },
    ) => Promise<unknown>
    const err = await call('/setup/complete', { baseUrl: 'https://evil.example' }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 0, code: 'cross_origin' })
    expect(sent).not.toHaveBeenCalled()
  })
})

describe('CSRF token capture', () => {
  it('leaves the token alone when a 2xx response carries none', async () => {
    server.use(http.get(`${V1}/tags`, () => HttpResponse.json({ items: [tag], next_cursor: '' })))
    csrf.set('keep')
    await api.GET(`${V1}/tags`)
    expect(csrf.get()).toBe('keep')
  })

  it('stores the token from a /auth/login response and sends it next', async () => {
    server.use(
      http.post(`${V1}/auth/login`, ({ request }) => {
        record(request)
        return HttpResponse.json({ mfa_required: true, csrf_token: 'from-login' })
      }),
      http.post(`${V1}/auth/totp`, ({ request }) => {
        record(request)
        return HttpResponse.json({ csrf_token: 'from-totp' })
      }),
    )

    await api.POST(`${V1}/auth/login`, { body: { username: 'owner', password: 'pw' } })
    expect(csrf.get()).toBe('from-login')
    await api.POST(`${V1}/auth/totp`, { body: { code: '123456' } })

    expect(seenCsrf[`POST ${V1}/auth/login`]).toBeNull()
    expect(seenCsrf[`POST ${V1}/auth/totp`]).toBe('from-login')
    expect(csrf.get()).toBe('from-totp')
  })

  it.each([
    ['POST', '/auth/totp/enroll/verify', { csrf_token: 'rotated' }],
    ['POST', '/auth/password', { csrf_token: 'rotated' }],
    ['GET', '/auth/me', { user, mfa_passed: true, totp_enrolled: true, csrf_token: 'rotated' }],
  ])('stores the token from %s %s', async (method, path, body) => {
    server.use(
      http.all(`${V1}${path}`, ({ request }) =>
        request.method === method ? HttpResponse.json(body) : undefined,
      ),
    )
    csrf.set('old')
    if (path === '/auth/me') await api.GET(`${V1}/auth/me`)
    else if (path === '/auth/password')
      await api.POST(`${V1}/auth/password`, {
        body: { current_password: 'a', new_password: 'b' },
      })
    else await api.POST(`${V1}/auth/totp/enroll/verify`, { body: { code: '123456' } })
    expect(csrf.get()).toBe('rotated')
  })

  it('reads a token only from the paths whose responses carry one (from the contract)', () => {
    expect([...CSRF_TOKEN_PATHS].toSorted()).toEqual([
      `${V1}/auth/login`,
      `${V1}/auth/me`,
      `${V1}/auth/password`,
      `${V1}/auth/totp`,
      `${V1}/auth/totp/enroll/verify`,
    ])
  })

  it('does not read the body of any other response', async () => {
    // A field of that name anywhere else is data, not the session's token.
    server.use(
      http.get(`${V1}/tags`, () =>
        HttpResponse.json({ items: [tag], next_cursor: '', csrf_token: 'not-a-token' }),
      ),
    )
    // MSW clones responses too; count only the clones made by client.ts.
    const original = Response.prototype.clone
    const clonedByClient: string[] = []
    const clone = vi.spyOn(Response.prototype, 'clone').mockImplementation(function (
      this: Response,
    ) {
      const stack = new Error().stack ?? ''
      if (/client\.ts/.test(stack)) clonedByClient.push(this.url)
      return original.call(this)
    })
    csrf.set('keep')
    await api.GET(`${V1}/tags`)
    clone.mockRestore()
    expect(clonedByClient).toEqual([])
    expect(csrf.get()).toBe('keep')
  })

  it('keeps the token in memory only', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    server.use(
      http.post(`${V1}/auth/login`, () =>
        HttpResponse.json({ mfa_required: false, csrf_token: 'secret' }),
      ),
    )
    await api.POST(`${V1}/auth/login`, { body: { username: 'owner', password: 'pw' } })
    expect(csrf.get()).toBe('secret')
    expect(setItem).not.toHaveBeenCalled()
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('secret')
    setItem.mockRestore()
  })
})

describe('errors', () => {
  it('turns a 403 "csrf" into an ApiError with code csrf', async () => {
    server.use(http.post(`${V1}/tags`, () => error(403, 'csrf', 'CSRF check failed')))
    const err = await api.POST(`${V1}/tags`, { body: { name: 'x' } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 403, code: 'csrf', message: 'CSRF check failed' })
  })

  it('on a 403 "csrf", asks for a fresh token once: no retry, no unauthorized handler', async () => {
    const onCsrfRejected = vi.fn()
    const onUnauthorized = vi.fn()
    setCsrfRejectedHandler(onCsrfRejected)
    setUnauthorizedHandler(onUnauthorized)
    let sent = 0
    server.use(
      http.post(`${V1}/tags`, () => {
        sent++
        return error(403, 'csrf', 'CSRF check failed')
      }),
    )
    csrf.set('stale')

    const err = await api.POST(`${V1}/tags`, { body: { name: 'x' } }).catch((e: unknown) => e)

    expect(err).toMatchObject({ status: 403, code: 'csrf' })
    expect(onCsrfRejected).toHaveBeenCalledOnce()
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(sent).toBe(1)
  })

  it('does not ask for a fresh token on any other 403', async () => {
    const onCsrfRejected = vi.fn()
    setCsrfRejectedHandler(onCsrfRejected)
    server.use(http.post(`${V1}/tags`, () => error(403, 'forbidden', 'owners only')))
    await api.POST(`${V1}/tags`, { body: { name: 'x' } }).catch(() => {})
    expect(onCsrfRejected).not.toHaveBeenCalled()
  })

  it('still rejects with the ApiError when the csrf handler throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    setCsrfRejectedHandler(() => {
      throw new Error('handler bug')
    })
    server.use(http.post(`${V1}/tags`, () => error(403, 'csrf', 'CSRF check failed')))
    const err = await api.POST(`${V1}/tags`, { body: { name: 'x' } }).catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 403, code: 'csrf' })
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it('keeps request_id', async () => {
    server.use(
      http.get(`${V1}/tags`, () =>
        error(500, 'internal', 'internal error', { request_id: 'req-42' }),
      ),
    )
    const err = await api.GET(`${V1}/tags`).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 500, code: 'internal', requestId: 'req-42' })
  })

  it('maps a non-JSON error body to code "unknown" and the status text', async () => {
    server.use(
      http.get(
        `${V1}/tags`,
        () =>
          new HttpResponse('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
      ),
    )
    const err = await api.GET(`${V1}/tags`).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 502, code: 'unknown', message: 'Bad Gateway' })
    expect((err as ApiError).requestId).toBeUndefined()
  })
})

describe('401', () => {
  it('calls the unauthorized handler once for a burst of concurrent 401s', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    server.use(http.get(`${V1}/tags`, () => error(401, 'unauthenticated', 'sign in')))

    const results = await Promise.allSettled([
      api.GET(`${V1}/tags`),
      api.GET(`${V1}/tags`),
      api.GET(`${V1}/tags`),
    ])

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    for (const r of results) {
      expect(r.status).toBe('rejected')
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        status: 401,
        code: 'unauthenticated',
      })
    }
  })

  it('calls it again for a later request that also gets 401, and clears the token', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    server.use(http.get(`${V1}/tags`, () => error(401, 'unauthenticated', 'sign in')))
    csrf.set('stale')

    await api.GET(`${V1}/tags`).catch(() => {})
    expect(csrf.get()).toBe('')
    await api.GET(`${V1}/tags`).catch(() => {})
    expect(onUnauthorized).toHaveBeenCalledTimes(2)
  })

  it('ignores a 401 from a request sent before a new session started', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    server.use(
      http.get(`${V1}/tags`, async () => {
        await delay(50)
        return error(401, 'unauthenticated', 'sign in')
      }),
      http.post(`${V1}/auth/login`, () =>
        HttpResponse.json({ mfa_required: false, csrf_token: 'fresh' }),
      ),
    )

    const stale = api.GET(`${V1}/tags`).catch((e: unknown) => e)
    await api.POST(`${V1}/auth/login`, { body: { username: 'owner', password: 'pw' } })
    expect(await stale).toBeInstanceOf(ApiError)

    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(csrf.get()).toBe('fresh')
  })

  it('still rejects with the ApiError when the handler throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    setUnauthorizedHandler(() => {
      throw new Error('handler bug')
    })
    server.use(http.get(`${V1}/tags`, () => error(401, 'unauthenticated', 'sign in')))

    const err = await api.GET(`${V1}/tags`).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 401, code: 'unauthenticated' })
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it('does not call it for a failed sign-in (wrong password)', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    server.use(
      http.post(`${V1}/auth/login`, () => error(401, 'unauthenticated', 'invalid credentials')),
    )
    const err = await api
      .POST(`${V1}/auth/login`, { body: { username: 'owner', password: 'nope' } })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 401, code: 'unauthenticated' })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe('unwrap', () => {
  it('resolves to the response data', async () => {
    server.use(http.get(`${V1}/tags`, () => HttpResponse.json({ items: [tag], next_cursor: '' })))
    const page = await unwrap(api.GET(`${V1}/tags`))
    expect(page.items[0]?.name).toBe('office')
  })

  it('resolves to undefined for 204', async () => {
    server.use(http.delete(`${V1}/tags/:id`, () => new HttpResponse(null, { status: 204 })))
    await expect(
      unwrap(api.DELETE(`${V1}/tags/{id}`, { params: { path: { id: tag.id } } })),
    ).resolves.toBeUndefined()
  })

  it('rejects with the ApiError', async () => {
    server.use(http.get(`${V1}/tags`, () => error(403, 'forbidden', 'no')))
    await expect(unwrap(api.GET(`${V1}/tags`))).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    })
  })
})

describe('setupClient', () => {
  it('sends X-Setup-Token on every request and never X-CSRF-Token', async () => {
    const seen: [string, string | null, string | null][] = []
    const note = (request: Request) =>
      seen.push([
        `${request.method} ${new URL(request.url).pathname}`,
        request.headers.get('X-Setup-Token'),
        request.headers.get('X-CSRF-Token'),
      ])
    server.use(
      http.get('/setup/status', ({ request }) => {
        note(request)
        return HttpResponse.json({ setup_complete: false })
      }),
      http.post('/setup/owner', ({ request }) => {
        note(request)
        return HttpResponse.json({ id: user.id }, { status: 201 })
      }),
    )
    csrf.set('session-token')

    const setup = setupClient('setup-secret')
    await setup.GET('/setup/status')
    await setup.POST('/setup/owner', { body: { username: 'owner', password: 'long password' } })

    expect(seen).toEqual([
      ['GET /setup/status', 'setup-secret', null],
      ['POST /setup/owner', 'setup-secret', null],
    ])
  })

  it('throws ApiError and does not call the unauthorized handler', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    server.use(http.post('/setup/complete', () => error(401, 'unauthenticated', 'bad token')))

    const err = await setupClient('wrong')
      .POST('/setup/complete')
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 401, code: 'unauthenticated', message: 'bad token' })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe('a 403 asking for the second factor mid-session', () => {
  it.each(['mfa_required', 'totp_enroll_required'])(
    'on %s, calls the second-factor handler once and still rejects with the ApiError',
    async (code) => {
      const onSecondFactor = vi.fn()
      setSecondFactorRequiredHandler(onSecondFactor)
      server.use(http.get(`${V1}/tags`, () => error(403, code, 'second factor first')))
      const err = await api.GET(`${V1}/tags`).catch((e: unknown) => e)
      expect(err).toMatchObject({ status: 403, code })
      expect(onSecondFactor).toHaveBeenCalledOnce()
    },
  )

  it.each(['csrf', 'forbidden'])('does not call it on a 403 %s', async (code) => {
    const onSecondFactor = vi.fn()
    setSecondFactorRequiredHandler(onSecondFactor)
    server.use(http.post(`${V1}/tags`, () => error(403, code, 'no')))
    await api.POST(`${V1}/tags`, { body: { name: 'x' } }).catch(() => {})
    expect(onSecondFactor).not.toHaveBeenCalled()
  })

  it('still rejects with the ApiError when the handler throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    setSecondFactorRequiredHandler(() => {
      throw new Error('handler bug')
    })
    server.use(http.get(`${V1}/tags`, () => error(403, 'mfa_required', 'second factor first')))
    const err = await api.GET(`${V1}/tags`).catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 403, code: 'mfa_required' })
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })
})
