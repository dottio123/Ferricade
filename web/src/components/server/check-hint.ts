import type { Check } from './server-checks'

export function checkHint(reason: Check['reason'], address: string, target: string): string | null {
  const destination = address || target
  switch (reason) {
    case 'dns':
      return 'The name could not be resolved. Check the host in Server settings and your DNS.'
    case 'refused':
      return `Nothing accepts connections at ${destination}. Is that the machine running the RustDesk server, with its ports published?`
    case 'timeout':
      return `No answer from ${destination} within 3 seconds. Usually a firewall, a missing port forward, or a router without NAT loopback.`
    case 'unreachable':
      return `The network cannot reach ${destination}. Check routing or VPN.`
    default:
      return null
  }
}
