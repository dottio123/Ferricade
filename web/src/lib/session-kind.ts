export function sessionKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    remote: 'Remote',
    file_transfer: 'File transfer',
    port_forward: 'Port forward',
    terminal: 'Terminal',
    camera: 'Camera',
  }
  return labels[kind] ?? 'Unknown'
}
