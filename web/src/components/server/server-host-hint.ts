export function serverHostWithoutPort(value: string): string {
  const host = value.trim()
  const bracketedIPv6 = host.match(/^(\[[^\]]+\])(?::\d+)?$/)
  if (bracketedIPv6) return bracketedIPv6[1]!
  return (host.match(/:/g) ?? []).length === 1 ? host.replace(/:\d+$/, '') : host
}

export function serverHostWarning(value: string): string | null {
  const host = serverHostWithoutPort(value).replace(/^\[|\]$/g, '')
  const normalized = host.toLowerCase()
  if (
    normalized !== '127.0.0.1' &&
    normalized !== '::1' &&
    normalized !== 'localhost' &&
    (host.includes('.') || host.includes(':') || !host)
  ) {
    return null
  }
  return `Clients on other machines can't reach ${host}. Use this server's LAN IP or DNS name.`
}
