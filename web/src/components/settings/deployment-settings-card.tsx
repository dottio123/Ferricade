import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { components } from '@/api/schema'

type SettingEntry = components['schemas']['DeploymentSetting']
type SettingValue = components['schemas']['DeploymentSettingValue']

interface DeploymentSettingsCardProps {
  catalog: SettingEntry[]
  settings: Record<string, SettingValue>
  disabled: boolean
  onToggleInclude: (key: string, include: boolean) => void
  onValueChange: (key: string, value: string) => void
}

export function formatOsBadge(osList: ('windows' | 'linux' | 'macos')[]): string | null {
  if (osList.length >= 3) return null
  const names = osList.map((os) => {
    if (os === 'windows') return 'Windows'
    if (os === 'linux') return 'Linux'
    if (os === 'macos') return 'macOS'
    return os
  })
  if (names.length === 1) return `${names[0]} only`
  return names.join(', ')
}

export function DeploymentSettingRow({
  setting,
  current,
  disabled,
  onToggleInclude,
  onValueChange,
}: {
  setting: SettingEntry
  current: SettingValue
  disabled: boolean
  onToggleInclude: (key: string, include: boolean) => void
  onValueChange: (key: string, value: string) => void
}) {
  const isIncluded = current.include
  const osBadge = formatOsBadge(setting.os)

  return (
    <div
      data-slot={`setting-row-${setting.key}`}
      className={cn(
        'flex flex-col gap-3 rounded-lg border p-3.5 transition-all sm:flex-row sm:items-center sm:justify-between',
        isIncluded ? 'border-border bg-card' : 'border-border/60 bg-muted/25',
      )}
    >
      <div className="flex flex-col gap-1 pr-2 sm:max-w-[65%]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{setting.label}</span>
          {osBadge && (
            <Badge
              variant="outline"
              className="text-xs py-0 px-1.5 font-normal text-muted-foreground"
            >
              {osBadge}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">{setting.help}</p>
      </div>

      <div className="flex items-center justify-between gap-4 sm:justify-end">
        {/* Include in script toggle */}
        <div className="flex items-center gap-2">
          <label
            htmlFor={`include-${setting.key}`}
            className="text-xs text-muted-foreground cursor-pointer select-none"
          >
            Include in script
          </label>
          <Switch
            id={`include-${setting.key}`}
            checked={isIncluded}
            onCheckedChange={(checked) => onToggleInclude(setting.key, checked)}
            disabled={disabled}
            aria-label={`Include in script ${setting.label}`}
          />
        </div>

        {/* Value control */}
        <div className="w-40 flex justify-end">
          {setting.type === 'bool' ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-muted-foreground w-4 text-center">
                {current.value === 'Y' ? 'ON' : 'OFF'}
              </span>
              <Switch
                checked={current.value === 'Y'}
                onCheckedChange={(checked) => onValueChange(setting.key, checked ? 'Y' : 'N')}
                disabled={disabled || !isIncluded}
                aria-label={`${setting.label} value`}
              />
            </div>
          ) : (
            <Select
              value={current.value}
              onValueChange={(val) => onValueChange(setting.key, val)}
              disabled={disabled || !isIncluded}
            >
              <SelectTrigger aria-label={`${setting.label} value`} className="h-8 text-xs w-full">
                <SelectValue placeholder="Select value" />
              </SelectTrigger>
              <SelectContent>
                {setting.values.map((v) => (
                  <SelectItem key={v} value={v} className="text-xs">
                    {setting.value_labels[v] ?? (v === '' ? 'Default (unset)' : v)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    </div>
  )
}

export function DeploymentSettingsCard({
  catalog,
  settings,
  disabled,
  onToggleInclude,
  onValueChange,
}: DeploymentSettingsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Client settings</CardTitle>
        <CardDescription className="text-xs">
          Pre-configure RustDesk client behavior and security options on deployed endpoints.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {catalog.map((setting) => {
          const current = settings[setting.key] ?? {
            include: false,
            value: setting.default || (setting.type === 'bool' ? 'N' : (setting.values[0] ?? '')),
          }
          return (
            <DeploymentSettingRow
              key={setting.key}
              setting={setting}
              current={current}
              disabled={disabled}
              onToggleInclude={onToggleInclude}
              onValueChange={onValueChange}
            />
          )
        })}
        {catalog.some((setting) =>
          [
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
          ].includes(setting.key),
        ) && (
          <p className="text-xs text-muted-foreground">
            Managing a permission also sets the device&apos;s permission preset to Custom, otherwise
            Full access would override it.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
