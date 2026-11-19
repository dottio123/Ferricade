import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import { useMe } from '@/auth/session'
import { CopyField } from '@/components/brand/copy-field'
import { ErrorState } from '@/components/brand/error-state'
import { RelativeTime } from '@/components/brand/relative-time'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { queryKeys } from '@/lib/queryKeys'
import type { components } from '@/api/schema'
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  Loader2Icon,
  ShieldAlertIcon,
} from 'lucide-react'

type LogExport = components['schemas']['LogExport']
type LogExportSettings = components['schemas']['LogExportSettings']
type LogExportOutputStatus = components['schemas']['LogExportOutputStatus']
type SyslogFacility = LogExportSettings['syslog']['facility']
type SyslogFormat = LogExportSettings['syslog']['format']
type LogExportTestResult = components['schemas']['LogExportTestResult']

const SYSLOG_FACILITIES: SyslogFacility[] = [
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
]

function parseFieldErrors(message: string): {
  fieldErrors: Record<string, string>
  formError: string | null
} {
  const fields = [
    'syslog.host',
    'syslog.port',
    'syslog.tls',
    'syslog.ca_pem',
    'syslog.facility',
    'syslog.format',
    'file.enabled',
    'syslog.enabled',
  ]
  for (const field of fields) {
    if (message.includes(field)) {
      return { fieldErrors: { [field]: message }, formError: null }
    }
  }
  return { fieldErrors: {}, formError: message }
}

interface OutputStatusProps {
  title: string
  status: LogExportOutputStatus
}

function OutputStatus({ title, status }: OutputStatusProps) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        {title} Status
      </h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 text-xs">
        <div>
          <span className="text-muted-foreground block mb-0.5">Events waiting</span>
          <span className="font-semibold text-foreground text-sm">
            {status.pending} {status.pending === 1 ? 'event' : 'events'}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground block mb-0.5">Last delivery</span>
          <span className="font-medium text-foreground">
            {status.last_delivered_at ? <RelativeTime date={status.last_delivered_at} /> : 'Never'}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground block mb-0.5">Last error</span>
          {status.last_error ? (
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-destructive break-words" title={status.last_error}>
                {status.last_error}
              </span>
              {status.last_error_at && (
                <span className="text-muted-foreground text-xs">
                  <RelativeTime date={status.last_error_at} />
                </span>
              )}
            </div>
          ) : (
            <span className="font-medium text-muted-foreground">None</span>
          )}
        </div>
      </div>
    </div>
  )
}

interface LogExportFormProps {
  initialData: LogExport
  isOwner: boolean
}

function LogExportForm({ initialData, isOwner }: LogExportFormProps) {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [form, setForm] = React.useState<LogExportSettings>(initialData.settings)
  const [savedSettings, setSavedSettings] = React.useState<LogExportSettings>(initialData.settings)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})
  const [formError, setFormError] = React.useState<string | null>(null)

  const [fileTestResult, setFileTestResult] = React.useState<LogExportTestResult | null>(null)
  const [syslogTestResult, setSyslogTestResult] = React.useState<LogExportTestResult | null>(null)

  const hasUnsavedChanges = React.useMemo(() => {
    return JSON.stringify(form) !== JSON.stringify(savedSettings)
  }, [form, savedSettings])

  const saveMutation = useMutation({
    mutationFn: async (body: LogExportSettings) => {
      return unwrap(
        api.PUT('/admin/api/v1/settings/log-export', {
          body,
        }),
      )
    },
    onSuccess: (saved) => {
      setFieldErrors({})
      setFormError(null)
      setForm(saved.settings)
      setSavedSettings(saved.settings)
      setFileTestResult(null)
      setSyslogTestResult(null)
      queryClient.setQueryData(queryKeys.logExport(), saved)
      void queryClient.invalidateQueries({ queryKey: queryKeys.logExport() })
      toast({ title: 'Log export settings saved' })
    },
    onError: (err) => {
      const msg = describeError(err).message
      const { fieldErrors: fe, formError: foe } = parseFieldErrors(msg)
      setFieldErrors(fe)
      setFormError(foe)
    },
  })

  const fileTestMutation = useMutation({
    mutationFn: async () => {
      return unwrap(
        api.POST('/admin/api/v1/settings/log-export/test', {
          body: { output: 'file' },
        }),
      )
    },
    onSuccess: (res) => {
      setFileTestResult(res)
    },
    onError: (err) => {
      setFileTestResult({ ok: false, error: describeError(err).message })
    },
  })

  const syslogTestMutation = useMutation({
    mutationFn: async () => {
      return unwrap(
        api.POST('/admin/api/v1/settings/log-export/test', {
          body: { output: 'syslog' },
        }),
      )
    },
    onSuccess: (res) => {
      setSyslogTestResult(res)
    },
    onError: (err) => {
      setSyslogTestResult({ ok: false, error: describeError(err).message })
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isOwner || saveMutation.isPending) return
    setFormError(null)
    setFieldErrors({})
    saveMutation.mutate(form)
  }

  const handleTlsChange = (checked: boolean) => {
    setForm((prev) => {
      let nextPort = prev.syslog.port
      if (checked && prev.syslog.port === 514) {
        nextPort = 6514
      } else if (!checked && prev.syslog.port === 6514) {
        nextPort = 514
      }
      return {
        ...prev,
        syslog: {
          ...prev.syslog,
          tls: checked,
          port: nextPort,
        },
      }
    })
  }

  const handleHostChange = (host: string) => {
    setFieldErrors((prev) => {
      if (!prev['syslog.host']) return prev
      const next = { ...prev }
      delete next['syslog.host']
      return next
    })
    setForm((prev) => ({
      ...prev,
      syslog: {
        ...prev.syslog,
        host,
      },
    }))
  }

  const handlePortChange = (val: string) => {
    setFieldErrors((prev) => {
      if (!prev['syslog.port']) return prev
      const next = { ...prev }
      delete next['syslog.port']
      return next
    })
    const num = parseInt(val, 10)
    setForm((prev) => ({
      ...prev,
      syslog: {
        ...prev.syslog,
        port: Number.isNaN(num) ? 0 : num,
      },
    }))
  }

  const handleCaPemChange = (ca_pem: string) => {
    setFieldErrors((prev) => {
      if (!prev['syslog.ca_pem']) return prev
      const next = { ...prev }
      delete next['syslog.ca_pem']
      return next
    })
    setForm((prev) => ({
      ...prev,
      syslog: {
        ...prev.syslog,
        ca_pem,
      },
    }))
  }

  return (
    <div className="flex flex-col gap-8 w-full max-w-4xl mx-auto">
      <PageHeader
        title="Log Export"
        description="Send the audit trail and remote sessions to a log file or a syslog collector."
        backLink={{ to: '/settings', label: 'Settings' }}
      />

      {!isOwner && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <ShieldAlertIcon className="size-4 shrink-0 text-muted-foreground" />
          <span>
            Only owners can edit log export settings. Values are displayed in read-only mode.
          </span>
        </div>
      )}

      {formError && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
        >
          {formError}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-8">
        {/* Log File section */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <div className="flex flex-col gap-1">
              <CardTitle className="text-base font-semibold">Log File</CardTitle>
              <CardDescription className="text-xs">
                Append audit and session events to a local JSON Lines file.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="log-file-enabled" className="text-xs text-muted-foreground sr-only">
                Enable log file export
              </label>
              <Switch
                id="log-file-enabled"
                checked={form.file.enabled}
                onCheckedChange={(checked) =>
                  setForm((prev) => ({
                    ...prev,
                    file: { ...prev.file, enabled: checked },
                  }))
                }
                disabled={!isOwner || saveMutation.isPending}
                aria-label="Enable log file export"
              />
            </div>
          </CardHeader>

          <CardContent className="flex flex-col gap-6 pt-0">
            {/* Path */}
            <div className="flex flex-col gap-1.5">
              <CopyField value="/var/log/ferricade/events.jsonl" label="Log file path" />
              <p className="text-xs text-muted-foreground">
                Container path, mounted as{' '}
                <code className="font-mono text-foreground font-semibold">./logs</code> in Docker
                Compose.
              </p>
            </div>

            {/* Zabbix hint */}
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3.5 text-xs text-muted-foreground flex flex-col gap-1">
              <span className="font-medium text-foreground">Using Zabbix?</span>
              <span>
                The Zabbix agent can read the log file with a{' '}
                <code className="font-mono text-foreground font-semibold">logrt[]</code> item.{' '}
                <a
                  href="https://github.com/dottio123/ferricade#log-export"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline font-medium inline-flex items-center gap-1"
                >
                  How to set it up
                  <ExternalLinkIcon className="size-3" />
                </a>
              </span>
            </div>

            {/* Status */}
            <OutputStatus title="Log File" status={initialData.status.file} />

            {/* Test button & inline result (Owner only) */}
            {isOwner && (
              <div className="flex flex-col gap-2 pt-1 border-t border-border/50">
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={hasUnsavedChanges || fileTestMutation.isPending}
                    onClick={() => fileTestMutation.mutate()}
                  >
                    {fileTestMutation.isPending ? (
                      <>
                        <Loader2Icon className="size-3.5 animate-spin mr-1.5" />
                        Sending test…
                      </>
                    ) : (
                      'Send test event'
                    )}
                  </Button>

                  {hasUnsavedChanges && (
                    <span className="text-xs text-muted-foreground">
                      Save changes first to test with updated settings.
                    </span>
                  )}

                  {!hasUnsavedChanges &&
                    fileTestResult &&
                    (fileTestResult.ok ? (
                      <span className="flex items-center gap-1.5 text-xs font-medium text-status-online">
                        <CheckCircle2Icon className="size-4 shrink-0" />
                        Test event delivered
                      </span>
                    ) : (
                      <span
                        role="alert"
                        className="flex items-center gap-1.5 text-xs text-destructive"
                      >
                        <AlertCircleIcon className="size-4 shrink-0" />
                        {fileTestResult.error || 'Delivery failed'}
                      </span>
                    ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Syslog section */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <div className="flex flex-col gap-1">
              <CardTitle className="text-base font-semibold">Syslog</CardTitle>
              <CardDescription className="text-xs">
                Stream events over TCP to an external syslog server or SIEM.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="syslog-enabled" className="text-xs text-muted-foreground sr-only">
                Enable syslog export
              </label>
              <Switch
                id="syslog-enabled"
                checked={form.syslog.enabled}
                onCheckedChange={(checked) =>
                  setForm((prev) => ({
                    ...prev,
                    syslog: { ...prev.syslog, enabled: checked },
                  }))
                }
                disabled={!isOwner || saveMutation.isPending}
                aria-label="Enable syslog export"
              />
            </div>
          </CardHeader>

          <CardContent className="flex flex-col gap-6 pt-0">
            {/* Host & Port grid */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="sm:col-span-2 flex flex-col gap-1.5">
                <label htmlFor="syslog-host" className="text-xs font-medium text-muted-foreground">
                  Host
                </label>
                <Input
                  id="syslog-host"
                  type="text"
                  value={form.syslog.host}
                  onChange={(e) => handleHostChange(e.target.value)}
                  disabled={!isOwner || saveMutation.isPending}
                  placeholder="e.g. syslog.example.com or 203.0.113.10"
                  aria-invalid={Boolean(fieldErrors['syslog.host'])}
                />
                {fieldErrors['syslog.host'] ? (
                  <p role="alert" className="text-xs text-destructive mt-0.5">
                    {fieldErrors['syslog.host']}
                  </p>
                ) : form.syslog.enabled && !form.syslog.host ? (
                  <p className="text-xs text-status-pending mt-0.5 flex items-center gap-1">
                    <AlertCircleIcon className="size-3.5 shrink-0" />
                    Host name or IP address is required when syslog is enabled.
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="syslog-port" className="text-xs font-medium text-muted-foreground">
                  Port
                </label>
                <Input
                  id="syslog-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={form.syslog.port || ''}
                  onChange={(e) => handlePortChange(e.target.value)}
                  disabled={!isOwner || saveMutation.isPending}
                  aria-invalid={Boolean(fieldErrors['syslog.port'])}
                />
                {fieldErrors['syslog.port'] && (
                  <p role="alert" className="text-xs text-destructive mt-0.5">
                    {fieldErrors['syslog.port']}
                  </p>
                )}
              </div>
            </div>

            {/* TLS Switch */}
            <div className="flex items-center justify-between rounded-lg border border-border p-3.5">
              <div className="flex flex-col gap-0.5">
                <label
                  htmlFor="syslog-tls"
                  className="text-sm font-medium text-foreground cursor-pointer"
                >
                  Use TLS
                </label>
                <p className="text-xs text-muted-foreground">
                  Verify server certificate and encrypt transmission (TLS 1.2+). Defaults to port
                  6514 with TLS, 514 without.
                </p>
              </div>
              <Switch
                id="syslog-tls"
                checked={form.syslog.tls}
                onCheckedChange={handleTlsChange}
                disabled={!isOwner || saveMutation.isPending}
                aria-label="Use TLS"
              />
            </div>

            {/* Format & Facility */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="syslog-format"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Format
                </label>
                <Select
                  value={form.syslog.format}
                  onValueChange={(val: SyslogFormat) =>
                    setForm((prev) => ({
                      ...prev,
                      syslog: { ...prev.syslog, format: val },
                    }))
                  }
                  disabled={!isOwner || saveMutation.isPending}
                >
                  <SelectTrigger id="syslog-format" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="json">JSON</SelectItem>
                    <SelectItem value="text">Text</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="syslog-facility"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Facility
                </label>
                <Select
                  value={form.syslog.facility}
                  onValueChange={(val: SyslogFacility) =>
                    setForm((prev) => ({
                      ...prev,
                      syslog: { ...prev.syslog, facility: val },
                    }))
                  }
                  disabled={!isOwner || saveMutation.isPending}
                >
                  <SelectTrigger id="syslog-facility" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SYSLOG_FACILITIES.map((facility) => (
                      <SelectItem key={facility} value={facility}>
                        {facility}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* CA Certificate */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="syslog-ca-pem"
                  className="text-xs font-medium text-muted-foreground"
                >
                  CA certificate
                </label>
                <span className="text-xs text-muted-foreground">Optional</span>
              </div>
              <textarea
                id="syslog-ca-pem"
                rows={4}
                value={form.syslog.ca_pem}
                onChange={(e) => handleCaPemChange(e.target.value)}
                disabled={!isOwner || saveMutation.isPending}
                maxLength={32768}
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono text-foreground shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
              <p className="text-xs text-muted-foreground">
                PEM; only for a private CA (max 32,768 characters).
              </p>
              {fieldErrors['syslog.ca_pem'] && (
                <p role="alert" className="text-xs text-destructive mt-0.5">
                  {fieldErrors['syslog.ca_pem']}
                </p>
              )}
            </div>

            {/* Status */}
            <OutputStatus title="Syslog" status={initialData.status.syslog} />

            {/* Test button & inline result (Owner only) */}
            {isOwner && (
              <div className="flex flex-col gap-2 pt-1 border-t border-border/50">
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={hasUnsavedChanges || syslogTestMutation.isPending}
                    onClick={() => syslogTestMutation.mutate()}
                  >
                    {syslogTestMutation.isPending ? (
                      <>
                        <Loader2Icon className="size-3.5 animate-spin mr-1.5" />
                        Sending test…
                      </>
                    ) : (
                      'Send test event'
                    )}
                  </Button>

                  {hasUnsavedChanges && (
                    <span className="text-xs text-muted-foreground">
                      Save changes first to test with updated settings.
                    </span>
                  )}

                  {!hasUnsavedChanges &&
                    syslogTestResult &&
                    (syslogTestResult.ok ? (
                      <span className="flex items-center gap-1.5 text-xs font-medium text-status-online">
                        <CheckCircle2Icon className="size-4 shrink-0" />
                        Test event delivered
                      </span>
                    ) : (
                      <span
                        role="alert"
                        className="flex items-center gap-1.5 text-xs text-destructive"
                      >
                        <AlertCircleIcon className="size-4 shrink-0" />
                        {syslogTestResult.error || 'Delivery failed'}
                      </span>
                    ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Footer with last changed info and Save button */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
          <div className="text-xs text-muted-foreground">
            {initialData.updated_by ? (
              <span>
                Last changed by {initialData.updated_by.display_name} ·{' '}
                <RelativeTime date={initialData.updated_at} />
              </span>
            ) : initialData.updated_at ? (
              <span>
                Last changed · <RelativeTime date={initialData.updated_at} />
              </span>
            ) : null}
          </div>

          {isOwner && (
            <Button type="submit" disabled={!hasUnsavedChanges || saveMutation.isPending}>
              {saveMutation.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}

export function LogExportView() {
  const { data: me } = useMe()
  const isOwner = me?.user.role === 'owner'

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.logExport(),
    queryFn: () => unwrap(api.GET('/admin/api/v1/settings/log-export')),
    refetchInterval: 10_000,
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-8 w-full max-w-4xl mx-auto">
        <PageHeader
          title="Log Export"
          description="Send the audit trail and remote sessions to a log file or a syslog collector."
          backLink={{ to: '/settings', label: 'Settings' }}
        />
        <div className="flex flex-col gap-6">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex flex-col gap-8 w-full max-w-4xl mx-auto">
        <PageHeader
          title="Log Export"
          description="Send the audit trail and remote sessions to a log file or a syslog collector."
          backLink={{ to: '/settings', label: 'Settings' }}
        />
        <ErrorState
          title="Failed to load log export settings"
          error={error}
          retry={() => void refetch()}
        />
      </div>
    )
  }

  return <LogExportForm initialData={data} isOwner={isOwner} />
}
