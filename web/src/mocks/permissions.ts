export const permissionKeys = new Set([
  'enable-keyboard',
  'enable-clipboard',
  'enable-file-transfer',
  'enable-audio',
  'enable-remote-restart',
  'enable-record-session',
  'enable-tunnel',
  'enable-remote-printer',
  'enable-camera',
  'enable-terminal',
  'enable-block-input',
  'enable-privacy-mode',
])

export const hasPermission = (settings: Record<string, unknown>) =>
  Object.keys(settings).some((key) => permissionKeys.has(key))
