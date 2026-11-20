// Dashboard thresholds, the module catalog and the signed-in admin's preferences.
import type { HttpHandler } from 'msw'
import type { components } from '../../api/schema'
import { CATALOG, MODULE_IDS, MODULE_SIZES, defaultSize, offersSize } from '../fixtures/catalog'
import { route, type Body, type Env } from '../route'
import { arr, bool, int, obj, readBody, str, req } from '../validate'

const V1 = '/admin/api/v1'

function hasCertificate(pemText: string): boolean {
  for (const match of pemText.matchAll(
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g,
  )) {
    const base64 = match[1]!.replace(/\s/g, '')
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) continue
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    } catch {
      continue
    }
    const tlv = (offset: number, limit: number) => {
      if (offset + 2 > limit) return null
      const tag = bytes[offset]!
      let length = bytes[offset + 1]!
      let start = offset + 2
      if (length >= 128) {
        const n = length - 128
        if (n < 1 || n > 4 || start + n > limit) return null
        length = 0
        for (let i = 0; i < n; i++) length = length * 256 + bytes[start++]!
      }
      const end = start + length
      return end <= limit ? { tag, start, end } : null
    }
    const outer = tlv(0, bytes.length)
    if (!outer || outer.tag !== 0x30 || outer.end !== bytes.length) continue
    const tbs = tlv(outer.start, outer.end)
    const algorithm = tbs && tlv(tbs.end, outer.end)
    const signature = algorithm && tlv(algorithm.end, outer.end)
    if (
      !tbs ||
      tbs.tag !== 0x30 ||
      algorithm?.tag !== 0x30 ||
      signature?.tag !== 0x03 ||
      signature.end !== outer.end ||
      signature.end - signature.start < 2
    )
      continue
    let cursor = tbs.start
    let item = tlv(cursor, tbs.end)
    if (item?.tag === 0xa0) {
      cursor = item.end
      item = tlv(cursor, tbs.end)
    }
    if (item?.tag !== 0x02 || item.end === item.start) continue // serial number
    cursor = item.end
    item = tlv(cursor, tbs.end)
    if (item?.tag !== 0x30) continue // signature algorithm
    cursor = item.end
    item = tlv(cursor, tbs.end)
    if (item?.tag !== 0x30) continue // issuer
    cursor = item.end
    item = tlv(cursor, tbs.end)
    if (item?.tag !== 0x30) continue // validity
    const notBefore = tlv(item.start, item.end)
    const notAfter = notBefore && tlv(notBefore.end, item.end)
    if (
      !notBefore ||
      !notAfter ||
      ![0x17, 0x18].includes(notBefore.tag) ||
      ![0x17, 0x18].includes(notAfter.tag) ||
      notAfter.end !== item.end
    )
      continue
    cursor = item.end
    item = tlv(cursor, tbs.end)
    if (item?.tag !== 0x30) continue // subject
    cursor = item.end
    item = tlv(cursor, tbs.end)
    if (item?.tag !== 0x30) continue // subject public key info
    const keyAlgorithm = tlv(item.start, item.end)
    const publicKey = keyAlgorithm && tlv(keyAlgorithm.end, item.end)
    if (keyAlgorithm?.tag === 0x30 && publicKey?.tag === 0x03 && publicKey.end === item.end)
      return true
  }
  return false
}

/** What the server offers a User: no fleet history charts, no wall display (prefs.go dashboardCatalog). */
const USER_MODULES = new Set<string>([
  'fleet-pulse',
  'quick-connect',
  'needs-attention',
  'live-sessions',
  'fleet-overview',
  'recent-sessions',
  'session-analytics',
  'platform-mix',
])

function userCatalog(): typeof CATALOG {
  return {
    modules: CATALOG.modules.filter((m) => USER_MODULES.has(m.id)),
    presets: CATALOG.presets
      .filter((p) => p.id !== 'wall')
      .map((p) => ({ ...p, modules: p.modules.filter((m) => USER_MODULES.has(m.id)) }))
      .filter((p) => p.modules.length > 0),
  }
}

export function settingsRoutes(env: Env): HttpHandler[] {
  const { db } = env
  let oidc: components['schemas']['OIDCSettings'] = {
    enabled: false,
    display_name: '',
    issuer: '',
    client_id: '',
    client_secret_set: false,
    redirect_uri: 'http://localhost/admin/api/v1/auth/oidc/callback',
    groups_claim: 'groups',
    owner_groups: [] as string[],
    admin_groups: [] as string[],
    user_groups: [] as string[],
    jit_enabled: false,
    last_test: null,
    updated_at: null,
  }

  return [
    route(env, 'staff', 'get', `${V1}/settings/sessions`, ({ respond }) =>
      respond(200, db.sessionSettings),
    ),
    route(env, 'owner', 'put', `${V1}/settings/sessions`, async ({ request, respond, actor }) => {
      const body = await readBody<Body<`${typeof V1}/settings/sessions`, 'put'>>(request, {
        lifetime: req(str({ values: ['browser', '8h', '1d', '7d', '30d'] })),
      })
      if (!body.ok) return respond.failure(body)
      return respond(200, db.setSessionSettings(body.value.lifetime, actor))
    }),
    route(env, 'staff', 'get', `${V1}/settings/log-export`, ({ respond }) =>
      respond(200, db.logExport),
    ),
    route(env, 'owner', 'put', `${V1}/settings/log-export`, async ({ request, respond, actor }) => {
      const body = await readBody<Body<`${typeof V1}/settings/log-export`, 'put'>>(request, {
        file: req(obj({ enabled: req(bool()) })),
        syslog: req(
          obj({
            enabled: req(bool()),
            host: req(str({ max: 253 })),
            port: req(int({ min: 1, max: 65535 })),
            tls: req(bool()),
            ca_pem: req(str({ max: 32768 })),
            facility: req(
              str({
                values: [
                  'kern',
                  'user',
                  'mail',
                  'daemon',
                  'auth',
                  'syslog',
                  'lpr',
                  'news',
                  'uucp',
                  'cron',
                  'authpriv',
                  'ftp',
                  'local0',
                  'local1',
                  'local2',
                  'local3',
                  'local4',
                  'local5',
                  'local6',
                  'local7',
                ],
              }),
            ),
            format: req(str({ values: ['json', 'text'] })),
          }),
        ),
      })
      if (!body.ok) return respond.failure(body)
      const { syslog } = body.value
      if (syslog.enabled && !syslog.host)
        return respond.error(400, 'bad_request', 'syslog.host: required when enabled')
      if (
        syslog.host &&
        (/[\s/\\]/.test(syslog.host) ||
          syslog.host.includes('://') ||
          (syslog.host.includes(':') && !/^[0-9a-f:]+$/i.test(syslog.host)))
      )
        return respond.error(400, 'bad_request', 'syslog.host: must be a host name or IP address')
      if (syslog.ca_pem && !hasCertificate(syslog.ca_pem))
        return respond.error(400, 'bad_request', 'syslog.ca_pem: no parseable certificate')
      return respond(200, db.setLogExport(body.value, actor))
    }),
    route(env, 'owner', 'post', `${V1}/settings/log-export/test`, async ({ request, respond }) => {
      const body = await readBody<Body<`${typeof V1}/settings/log-export/test`, 'post'>>(request, {
        output: req(str({ values: ['file', 'syslog'] })),
      })
      if (!body.ok) return respond.failure(body)
      if (body.value.output === 'syslog' && !db.logExport.settings.syslog.host)
        return respond(200, { ok: false, error: 'no syslog host set' })
      return respond(200, { ok: true, error: null })
    }),
    route(env, 'owner', 'get', `${V1}/settings/oidc`, ({ respond }) => respond(200, oidc)),
    route(env, 'owner', 'patch', `${V1}/settings/oidc`, async ({ request, respond }) => {
      const body = await readBody<Body<`${typeof V1}/settings/oidc`, 'patch'>>(request, {
        enabled: bool(),
        display_name: str({ min: 1, max: 64 }),
        issuer: str({ max: 512 }),
        client_id: str({ max: 256 }),
        client_secret: str({ min: 1, max: 1024 }),
        groups_claim: str({ min: 1, max: 128 }),
        owner_groups: arr(str({ min: 1, max: 256 }), { max: 32 }),
        admin_groups: arr(str({ min: 1, max: 256 }), { max: 32 }),
        user_groups: arr(str({ min: 1, max: 256 }), { max: 32 }),
        jit_enabled: bool(),
      })
      if (!body.ok) return respond.failure(body)
      const next = { ...oidc, ...body.value }
      if (body.value.client_secret !== undefined) next.client_secret_set = true
      if (
        next.enabled &&
        (!next.issuer ||
          !next.client_id ||
          !next.client_secret_set ||
          (!next.owner_groups.length && !next.admin_groups.length && !next.user_groups?.length))
      )
        return respond.error(
          400,
          'bad_request',
          'OIDC needs issuer, client ID, client secret and a role group',
        )
      if (
        next.issuer &&
        !/^https:\/\//.test(next.issuer) &&
        !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(next.issuer)
      )
        return respond.error(400, 'bad_request', 'issuer must use https')
      delete (next as Partial<typeof next>).client_secret
      oidc = { ...next, updated_at: new Date(db.now()).toISOString() }
      return respond(200, oidc)
    }),
    route(env, 'owner', 'post', `${V1}/settings/oidc/test`, ({ respond }) => {
      const ok = oidc.issuer.includes('example')
      const result: components['schemas']['OIDCTestResult'] = {
        tested_at: new Date(db.now()).toISOString(),
        ok,
        error: ok ? null : 'unreachable',
        authorization_endpoint: ok ? `${oidc.issuer}/authorize` : null,
        token_endpoint: ok ? `${oidc.issuer}/token` : null,
        userinfo_endpoint: ok ? `${oidc.issuer}/userinfo` : null,
        groups_scope_supported: ok,
      }
      oidc = { ...oidc, last_test: result }
      return respond(200, result)
    }),
    route(env, 'mfa', 'get', `${V1}/settings/dashboard`, ({ respond }) =>
      respond(200, db.thresholds),
    ),

    route(env, 'owner', 'put', `${V1}/settings/dashboard`, async ({ request, respond, actor }) => {
      const body = await readBody<Body<`${typeof V1}/settings/dashboard`, 'put'>>(request, {
        offline_days: req(int({ min: 1, max: 365 })),
        pending_hours: req(int({ min: 1, max: 720 })),
        min_client_version: req(str({ pattern: /^(\d+(\.\d+){0,3})?$/ })),
      })
      if (!body.ok) return respond.failure(body)
      const before = db.thresholds
      db.thresholds = body.value
      db.record(actor, 'settings.dashboard_updated', 'settings', 'dashboard', {
        before,
        after: body.value,
      })
      return respond(200, db.thresholds)
    }),

    route(env, 'mfa', 'get', `${V1}/dashboard/catalog`, ({ respond, actor }) =>
      respond(200, actor.role === 'user' ? userCatalog() : CATALOG),
    ),

    route(env, 'mfa', 'get', `${V1}/me/preferences`, ({ respond, actor }) =>
      respond(200, db.preferencesFor(actor.id)),
    ),

    route(env, 'mfa', 'put', `${V1}/me/preferences`, async ({ request, respond, actor }) => {
      type PreferencesPut = Omit<Body<`${typeof V1}/me/preferences`, 'put'>, 'palette'> & {
        palette?: 'ferricade' | 'indigo' | 'graphite' | 'ocean' | 'violet' | 'moss' | 'sandstone'
      }
      const body = await readBody<PreferencesPut>(request, {
        preset: req(str({ values: ['homelab', 'business', 'wall', 'custom'] })),
        modules: req(
          arr(
            obj({
              id: req(str({ values: MODULE_IDS })),
              enabled: req(bool()),
              size: str({ values: MODULE_SIZES }),
            }),
          ),
        ),
        pinned_device_ids: req(arr(str({ format: 'uuid' }), { max: 24, unique: true })),
        theme: req(str({ values: ['dark', 'light', 'system'] })),
        palette: str({
          values: ['ferricade', 'indigo', 'graphite', 'ocean', 'violet', 'moss', 'sandstone'],
        }),
        density: req(str({ values: ['comfortable', 'compact'] })),
        toast_seconds: { kind: 'integer', min: 0, max: 30 },
      })
      if (!body.ok) {
        if (body.message.startsWith('palette '))
          return respond.error(
            400,
            'bad_request',
            'palette must be ferricade, indigo, graphite, ocean, violet, moss or sandstone',
          )
        return respond.failure(body)
      }
      if (
        body.value.toast_seconds !== undefined &&
        ![0, 3, 5, 10, 30].includes(body.value.toast_seconds)
      )
        return respond.error(400, 'bad_request', 'toast_seconds must be 0, 3, 5, 10 or 30')
      const ids = body.value.modules.map((m) => m.id)
      if (new Set(ids).size !== ids.length)
        return respond.error(400, 'bad_request', 'a module is repeated')
      const unsized = body.value.modules.find((m) => m.size && !offersSize(m.id, m.size))
      if (unsized)
        return respond.error(
          400,
          'bad_request',
          `modules: ${unsized.id} cannot be shown at size "${unsized.size}"`,
        )
      const modules = body.value.modules.map((m) => ({
        ...m,
        size: m.size || defaultSize(m.id) || 'medium',
      }))
      return respond(
        200,
        db.savePreferences(actor.id, {
          ...body.value,
          palette: body.value.palette ?? db.preferencesFor(actor.id).palette,
          toast_seconds: body.value.toast_seconds ?? db.preferencesFor(actor.id).toast_seconds,
          modules,
        }),
      )
    }),
  ]
}
