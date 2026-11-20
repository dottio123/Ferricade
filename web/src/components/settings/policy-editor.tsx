import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { queryKeys } from '@/lib/queryKeys'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { formatOsBadge } from './deployment-settings-card'
import type { components } from '@/api/schema'
import { AlertTriangleIcon } from 'lucide-react'

type Policy = components['schemas']['Policy']
type PolicySettings = components['schemas']['PolicySettings']
type SettingEntry = components['schemas']['DeploymentSetting']

export interface PolicyEditorProps {
  policy?: Policy | null
  catalog: SettingEntry[]
  onClose: () => void
  onSaved: (policy: Policy) => void
}

function isAlwaysReachable(approveMode?: string, verificationMethod?: string): boolean {
  const validApprove = approveMode === 'password' || approveMode === 'password-click'
  const validMethod =
    verificationMethod === 'use-permanent-password' || verificationMethod === 'use-both-passwords'
  return validApprove && validMethod
}

export function PolicyEditor({ policy, catalog, onClose, onSaved }: PolicyEditorProps) {
  const isEditing = Boolean(policy)
  const isDefault = Boolean(policy?.is_default)
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [name, setName] = React.useState(policy?.name ?? '')
  const [settings, setSettings] = React.useState<Record<string, string>>(() => {
    if (policy) {
      return { ...policy.settings }
    }
    return {
      'approve-mode': 'password-click',
      'verification-method': 'use-both-passwords',
    }
  })
  const [formError, setFormError] = React.useState<string | null>(null)
  const [lockoutConfirmOpen, setLockoutConfirmOpen] = React.useState(false)

  // Catalog partitioning: baseline settings vs other settings
  const baselineSettings = React.useMemo(() => {
    const approve = catalog.find((s) => s.key === 'approve-mode')
    const verify = catalog.find((s) => s.key === 'verification-method')
    return [approve, verify].filter(Boolean) as SettingEntry[]
  }, [catalog])

  const otherSettings = React.useMemo(() => {
    return catalog.filter((s) => s.key !== 'approve-mode' && s.key !== 'verification-method')
  }, [catalog])

  const handleSettingChange = (key: string, value: string) => {
    setSettings((prev) => {
      const next = { ...prev }
      if (value === '__not_managed__') {
        delete next[key]
      } else {
        next[key] = value
      }
      return next
    })
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const cleanSettings: PolicySettings = {}
      // Always include baseline settings
      cleanSettings['approve-mode'] = settings['approve-mode'] ?? 'password-click'
      cleanSettings['verification-method'] = settings['verification-method'] ?? 'use-both-passwords'

      // Include all other managed settings
      for (const [k, v] of Object.entries(settings)) {
        if (k !== 'approve-mode' && k !== 'verification-method' && v && v !== '__not_managed__') {
          cleanSettings[k] = v
        }
      }

      if (policy) {
        // Update existing policy
        return unwrap(
          api.PATCH('/admin/api/v1/policies/{id}', {
            params: { path: { id: policy.id } },
            body: {
              ...(isDefault ? {} : { name: name.trim() }),
              settings: cleanSettings,
            },
          }),
        )
      } else {
        // Create new policy
        return unwrap(
          api.POST('/admin/api/v1/policies', {
            body: {
              name: name.trim(),
              settings: cleanSettings,
            },
          }),
        )
      }
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.policies() })
      if (policy) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.policy(policy.id) })
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups() })
      toast({ title: policy ? 'Policy saved' : 'Policy created' })
      onSaved(saved)
    },
    onError: (err) => {
      const desc = describeError(err)
      if (desc.code === 'name_taken') {
        setFormError('A policy with this name already exists.')
      } else {
        setFormError(desc.message)
      }
    },
  })

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    setFormError(null)

    if (!isDefault) {
      const trimmed = name.trim()
      if (trimmed.length < 1 || trimmed.length > 100) {
        setFormError('name: must contain 1 to 100 characters')
        return
      }
    }

    const currentApprove = settings['approve-mode']
    const currentVerify = settings['verification-method']
    if (!isAlwaysReachable(currentApprove, currentVerify)) {
      setLockoutConfirmOpen(true)
      return
    }

    saveMutation.mutate()
  }

  const handleConfirmSaveAnyway = () => {
    setLockoutConfirmOpen(false)
    saveMutation.mutate()
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-semibold">
                  {isEditing && policy ? `Edit ${policy.name}` : 'Create policy'}
                </CardTitle>
                <CardDescription className="text-xs mt-1">
                  {isDefault
                    ? 'Configure default settings applied to devices without a group-assigned policy.'
                    : 'Configure managed RustDesk client behaviors for devices in assigned groups.'}
                </CardDescription>
              </div>
              {isDefault && <Badge variant="secondary">Default</Badge>}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {/* Form Error Banner */}
            {formError && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
              >
                {formError}
              </div>
            )}

            {/* Policy Name Input */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="policy-name" className="text-xs font-medium text-foreground">
                Policy name
              </label>
              <Input
                id="policy-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isDefault || saveMutation.isPending}
                placeholder="e.g. Workstations"
                maxLength={100}
                required={!isDefault}
                className="max-w-md text-sm"
              />
              {isDefault && (
                <p className="text-2xs text-muted-foreground">
                  The Default policy cannot be renamed.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Baseline Access Security Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Access baseline</CardTitle>
            <CardDescription className="text-xs">
              Required access settings for this policy. These define how devices accept incoming
              connections normally and after an access window closes.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {baselineSettings.map((setting) => {
              const currentValue = settings[setting.key] ?? setting.default ?? ''
              const osBadge = formatOsBadge(setting.os)

              return (
                <div
                  key={setting.key}
                  data-slot={`setting-row-${setting.key}`}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col gap-1 pr-2 sm:max-w-[65%]">
                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        htmlFor={`setting-${setting.key}`}
                        className="text-sm font-medium text-foreground"
                      >
                        {setting.label}
                      </label>
                      {osBadge && (
                        <Badge
                          variant="outline"
                          className="text-xs py-0 px-1.5 font-normal text-muted-foreground"
                        >
                          {osBadge}
                        </Badge>
                      )}
                      <Badge
                        variant="outline"
                        className="text-2xs py-0 px-1 font-normal text-primary-text"
                      >
                        Required
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{setting.help}</p>
                  </div>

                  <div className="w-56 flex justify-end">
                    <Select
                      value={currentValue}
                      onValueChange={(val) => handleSettingChange(setting.key, val)}
                      disabled={saveMutation.isPending}
                    >
                      <SelectTrigger
                        id={`setting-${setting.key}`}
                        aria-label={setting.label}
                        className="h-8 text-xs w-full"
                      >
                        <SelectValue placeholder="Select value" />
                      </SelectTrigger>
                      <SelectContent>
                        {setting.values.map((v) => (
                          <SelectItem key={v} value={v} className="text-xs">
                            {setting.value_labels[v] ?? v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>

        {/* Other Catalog Settings Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Client settings</CardTitle>
            <CardDescription className="text-xs">
              Configure optional client settings. Settings marked &ldquo;Not managed&rdquo; leave
              existing values on the device untouched.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {otherSettings.map((setting) => {
              const isManaged = setting.key in settings
              const currentValue = isManaged ? settings[setting.key] : '__not_managed__'
              const osBadge = formatOsBadge(setting.os)

              return (
                <div
                  key={setting.key}
                  data-slot={`setting-row-${setting.key}`}
                  className={cn(
                    'flex flex-col gap-3 rounded-lg border p-3.5 transition-all sm:flex-row sm:items-center sm:justify-between',
                    isManaged ? 'border-border bg-card' : 'border-border/60 bg-muted/25',
                  )}
                >
                  <div className="flex flex-col gap-1 pr-2 sm:max-w-[65%]">
                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        htmlFor={`setting-${setting.key}`}
                        className="text-sm font-medium text-foreground"
                      >
                        {setting.label}
                      </label>
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

                  <div className="w-56 flex justify-end">
                    <Select
                      value={currentValue}
                      onValueChange={(val) => handleSettingChange(setting.key, val)}
                      disabled={saveMutation.isPending}
                    >
                      <SelectTrigger
                        id={`setting-${setting.key}`}
                        aria-label={setting.label}
                        className="h-8 text-xs w-full"
                      >
                        <SelectValue placeholder="Not managed" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem
                          value="__not_managed__"
                          className="text-xs text-muted-foreground"
                        >
                          Not managed
                        </SelectItem>
                        {(setting.values && setting.values.length > 0
                          ? setting.values
                          : setting.type === 'bool'
                            ? ['Y', 'N']
                            : []
                        ).map((v) => (
                          <SelectItem key={v} value={v} className="text-xs">
                            {setting.value_labels[v] ?? (v === 'Y' ? 'On' : v === 'N' ? 'Off' : v)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )
            })}
            {otherSettings.some((setting) =>
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
                Managing a permission also sets the device&apos;s permission preset to Custom,
                otherwise Full access would override it.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saveMutation.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving…' : isEditing ? 'Save changes' : 'Create policy'}
          </Button>
        </div>
      </form>

      {/* Lockout Confirmation Dialog */}
      <Dialog open={lockoutConfirmOpen} onOpenChange={setLockoutConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2 text-status-alert">
              <AlertTriangleIcon className="size-5 shrink-0" />
              <DialogTitle>Confirm access baseline</DialogTitle>
            </div>
            <DialogDescription className="text-xs leading-relaxed pt-2 text-foreground">
              Devices using this policy can only be reached through an access window or by someone
              at the device.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setLockoutConfirmOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={handleConfirmSaveAnyway}>
              Save anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
