import type { ClientConfig, Server } from './types'

export const SERVER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c05'
export const DEMO_PUBLIC_KEY = 'OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw='

export function createServer(now: number): Server {
  const at = new Date(now - 120 * 86_400_000).toISOString()
  return {
    id: SERVER_ID,
    name: 'default',
    id_host: 'rd.example.com',
    relay_host: 'rd.example.com',
    public_key: DEMO_PUBLIC_KEY,
    api_url: '',
    links_include_server: true,
    created_at: at,
    updated_at: at,
  }
}

const b64urlNoPad = (s: string) =>
  btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

/** reverse(base64url_nopad(JSON {host, relay, api, key})), as the contract describes. */
export function clientConfigFor(server: Server): ClientConfig {
  const hostOnly = server.id_host.replace(/:\d+$/, '')
  const api = server.api_url || `http://${hostOnly}:21114`
  const payload = JSON.stringify({
    host: server.id_host,
    relay: server.relay_host,
    api,
    key: server.public_key,
  })
  const configString = [...b64urlNoPad(payload)].reverse().join('')
  return {
    config_string: configString,
    deep_link: `rustdesk://config/${configString}`,
    api,
    host: server.id_host,
    relay: server.relay_host,
    key: server.public_key,
    install: {
      windows: `& "$env:ProgramFiles\\RustDesk\\rustdesk.exe" --config ${configString}`,
      macos: `sudo /Applications/RustDesk.app/Contents/MacOS/RustDesk --config ${configString}`,
      linux: `sudo rustdesk --config ${configString}`,
    },
  }
}
