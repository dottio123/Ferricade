import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { components } from '@/api/schema'
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

type Settings = components['schemas']['OIDCSettings']
type SessionSettings = components['schemas']['SessionSettings']
type Result = components['schemas']['OIDCTestResult']
type Patch = NonNullable<
  NonNullable<
    import('@/api/schema').paths['/admin/api/v1/settings/oidc']['patch']['requestBody']
  >['content']['application/json']
>
const fields = [
  'enabled',
  'display_name',
  'issuer',
  'client_id',
  'groups_claim',
  'owner_groups',
  'admin_groups',
  'user_groups',
  'jit_enabled',
] as const

export function oidcPatch(initial: Settings, current: Settings, secret: string): Patch {
  const patch: Patch = {}
  for (const field of fields) {
    if (JSON.stringify(initial[field]) !== JSON.stringify(current[field])) {
      Object.assign(patch, { [field]: current[field] })
    }
  }
  if (secret) patch.client_secret = secret
  return patch
}

const testErrors: Record<NonNullable<Result['error']>, string> = {
  unreachable: 'Provider is unreachable.',
  bad_status: 'Provider returned an unexpected status.',
  not_json: 'Provider did not return JSON.',
  issuer_mismatch: 'Provider issuer does not match.',
  missing_endpoints: 'Provider discovery is missing required endpoints.',
}

function TestResult({ result, previous = false }: { result: Result; previous?: boolean }) {
  return (
    <div role="status" className="space-y-1 text-xs text-muted-foreground">
      <p>
        {previous ? 'Last test' : 'Test result'}: {new Date(result.tested_at).toLocaleString()}
      </p>
      {result.ok ? (
        <>
          <p className="text-status-online">Connection succeeded.</p>
          <p>Authorization endpoint: {result.authorization_endpoint}</p>
          <p>Token endpoint: {result.token_endpoint}</p>
          <p>Userinfo endpoint: {result.userinfo_endpoint ?? 'Unavailable'}</p>
          <p>Groups scope: {result.groups_scope_supported ? 'supported' : 'not supported'}</p>
        </>
      ) : (
        <p className="text-destructive">
          {result.error ? testErrors[result.error] : 'Connection failed.'}
        </p>
      )}
    </div>
  )
}

function GroupsInput({
  id,
  label,
  value,
  onChange,
  error,
}: {
  id: string
  label: string
  value: string[]
  onChange: (value: string[]) => void
  error?: string | null
}) {
  const [draft, setDraft] = React.useState('')
  const add = () => {
    const group = draft.trim()
    if (group && !value.includes(group)) onChange([...value, group])
    setDraft('')
  }
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex flex-wrap gap-1.5">
        {value.map((group) => (
          <span
            key={group}
            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
          >
            {group}
            <button
              type="button"
              aria-label={`Remove ${group} from ${label}`}
              onClick={() => onChange(value.filter((item) => item !== group))}
              className="rounded-sm text-muted-foreground hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <Input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'oidc-form-error' : undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault()
            add()
          }
        }}
        onBlur={add}
        placeholder="Type a group, then Enter"
      />
    </div>
  )
}

function Form({ initial }: { initial: Settings }) {
  const me = useMe().data
  const isOwner = me?.user.role === 'owner'
  const [current, setCurrent] = React.useState(initial)
  const [secret, setSecret] = React.useState('')
  const [replaceSecret, setReplaceSecret] = React.useState(!initial.client_secret_set)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<Result | null>(null)
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const patch = oidcPatch(initial, current, secret)
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setCurrent((previous) => ({ ...previous, [key]: value }))
  const save = useMutation({
    mutationFn: () => unwrap(api.PATCH('/admin/api/v1/settings/oidc', { body: patch })),
    onSuccess: (saved) => {
      setCurrent(saved)
      setSecret('')
      setReplaceSecret(false)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['settings', 'oidc'] })
      toast({ title: 'Sign-in settings saved' })
    },
    onError: (err) => setError(describeError(err).message),
  })
  const test = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/api/v1/settings/oidc/test')),
    onSuccess: (tested) => {
      setResult(tested)
      void queryClient.invalidateQueries({ queryKey: ['settings', 'oidc'] })
    },
    onError: (err) => setError(describeError(err).message),
  })
  const field = (
    id: string,
    label: string,
    key: 'display_name' | 'issuer' | 'client_id' | 'groups_claim',
    hint?: string,
  ) => (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        value={current[key]}
        onChange={(event) => update(key, event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'oidc-form-error' : undefined}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
  return (
    <div className="space-y-6">
      {isOwner && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Sign-in provider</CardTitle>
            <CardDescription className="text-xs">
              Configure one OpenID Connect provider for console access.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                if (Object.keys(patch).length) save.mutate()
              }}
            >
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 p-3">
                <label htmlFor="oidc-enabled" className="text-xs font-medium">
                  Sign in with OIDC
                </label>
                <Switch
                  id="oidc-enabled"
                  checked={current.enabled}
                  onCheckedChange={(value) => update('enabled', value)}
                />
              </div>
              {field('oidc-name', 'Button name', 'display_name')}
              {field(
                'oidc-issuer',
                'Issuer URL',
                'issuer',
                'https, or http://localhost for testing',
              )}
              {field('oidc-client-id', 'Client ID', 'client_id')}
              <div className="space-y-1.5">
                <label htmlFor="oidc-secret" className="text-xs font-medium text-muted-foreground">
                  Client secret
                </label>
                {initial.client_secret_set && !replaceSecret ? (
                  <div className="flex items-center gap-3">
                    <span className="text-xs">A secret is saved</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setReplaceSecret(true)}
                    >
                      Replace secret
                    </Button>
                  </div>
                ) : (
                  <Input
                    id="oidc-secret"
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? 'oidc-form-error' : undefined}
                    type="password"
                    autoComplete="new-password"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                )}
              </div>
              <div className="space-y-1.5">
                <CopyField label="Redirect URI" value={current.redirect_uri} />
                <p className="text-xs text-muted-foreground">Register this at your provider</p>
              </div>
              {field('oidc-groups-claim', 'Groups claim', 'groups_claim')}
              <GroupsInput
                id="oidc-owner-groups"
                label="Owner groups"
                value={current.owner_groups}
                onChange={(value) => update('owner_groups', value)}
                error={error}
              />
              <GroupsInput
                id="oidc-admin-groups"
                label="Admin groups"
                value={current.admin_groups}
                onChange={(value) => update('admin_groups', value)}
                error={error}
              />
              <GroupsInput
                id="oidc-user-groups"
                label="User groups"
                value={current.user_groups}
                onChange={(value) => update('user_groups', value)}
                error={error}
              />
              <p className="text-xs text-muted-foreground">
                Set at least one owner, admin or user group; a person in none of them cannot sign
                in.
              </p>
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 p-3">
                <label htmlFor="oidc-jit" className="text-xs font-medium">
                  Create accounts on first sign-in (JIT)
                </label>
                <Switch
                  id="oidc-jit"
                  checked={current.jit_enabled}
                  onCheckedChange={(value) => update('jit_enabled', value)}
                />
              </div>
              {error && (
                <p id="oidc-form-error" role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-end">
                <Button type="submit" disabled={save.isPending || Object.keys(patch).length === 0}>
                  {save.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
      {isOwner && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Test connection</CardTitle>
            <CardDescription className="text-xs">
              Check the provider's discovery document.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => test.mutate()}
              disabled={test.isPending}
            >
              {test.isPending ? 'Testing…' : 'Test connection'}
            </Button>
            {result ? (
              <TestResult result={result} />
            ) : (
              initial.last_test && <TestResult result={initial.last_test} previous />
            )}
          </CardContent>
        </Card>
      )}
      {isOwner && (
        <p className="text-xs text-muted-foreground">
          Sign-ins through the provider skip Ferricade's two-factor step: the provider's own MFA
          applies. An account whose verified email matches a provider account is linked
          automatically.
        </p>
      )}
    </div>
  )
}

export function SignInSettingsView() {
  const me = useMe().data
  const isOwner = me?.user.role === 'owner'
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['settings', 'oidc'],
    queryFn: () => unwrap(api.GET('/admin/api/v1/settings/oidc')),
    enabled: isOwner,
  })
  const sessions = useQuery({
    queryKey: ['settings', 'sessions'],
    queryFn: () => unwrap(api.GET('/admin/api/v1/settings/sessions')),
  })
  return (
    <div className="flex w-full max-w-3xl flex-col gap-6 mx-auto">
      <PageHeader
        title="Sign-In"
        description="Configure sign-in duration and provider access."
        backLink={{ to: '/settings', label: 'Back to Settings' }}
      />
      {sessions.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : sessions.error ? (
        <ErrorState
          title="Failed to load sign-in duration"
          error={sessions.error}
          retry={() => void sessions.refetch()}
        />
      ) : sessions.data ? (
        <SessionDurationCard settings={sessions.data} isOwner={isOwner} />
      ) : null}
      {!isOwner && (
        <p className="text-xs text-muted-foreground">Only owners can manage sign-in settings.</p>
      )}
      {!isOwner ? null : isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : error ? (
        <ErrorState
          title="Failed to load sign-in settings"
          error={error}
          retry={() => void refetch()}
        />
      ) : (
        data && <Form key={data.updated_at ?? 'initial'} initial={data} />
      )}
    </div>
  )
}

const lifetimes = [
  {
    value: 'browser',
    label: 'Until the browser closes',
    description: 'Signed out 5 minutes after the last console tab closes. Most secure.',
  },
  {
    value: '8h',
    label: '8 hours',
    description:
      'Stays signed in across browser restarts until this time has passed since sign-in.',
  },
  {
    value: '1d',
    label: '1 day',
    description:
      'Stays signed in across browser restarts until this time has passed since sign-in.',
  },
  {
    value: '7d',
    label: '7 days',
    description:
      'Stays signed in across browser restarts until this time has passed since sign-in.',
  },
  {
    value: '30d',
    label: '30 days',
    description:
      'Stays signed in across browser restarts until this time has passed since sign-in.',
  },
] as const

function SessionDurationCard({
  settings,
  isOwner,
}: {
  settings: SessionSettings
  isOwner: boolean
}) {
  const [lifetime, setLifetime] = React.useState<SessionSettings['lifetime']>(settings.lifetime)
  const [error, setError] = React.useState<string | null>(null)
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const save = useMutation({
    mutationFn: (value: SessionSettings['lifetime']) =>
      unwrap(api.PUT('/admin/api/v1/settings/sessions', { body: { lifetime: value } })),
    onSuccess: (saved) => {
      setLifetime(saved.lifetime)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['settings', 'sessions'] })
      toast({ title: 'Sign-in duration saved' })
    },
    onError: (err) => setError(describeError(err).message),
  })
  const changed = lifetime !== settings.lifetime
  const selected = lifetimes.find((option) => option.value === lifetime)
  const hasSavedLifetime = lifetimes.some((option) => option.value === settings.lifetime)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Sign-in duration</CardTitle>
        <CardDescription className="text-xs">
          Choose how long a console sign-in lasts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (changed) save.mutate(lifetime)
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="session-lifetime" className="text-xs font-medium text-muted-foreground">
              Sign-in duration
            </label>
            <Select
              value={lifetime}
              onValueChange={(value) => setLifetime(value as SessionSettings['lifetime'])}
              disabled={!isOwner || save.isPending}
            >
              <SelectTrigger id="session-lifetime" className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {!hasSavedLifetime && (
                  <SelectItem value={settings.lifetime}>{settings.lifetime}</SelectItem>
                )}
                {lifetimes.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {selected
                ? selected.description
                : 'Custom sign-in duration configured on the server.'}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Applies to new sign-ins. A shorter duration also shortens sessions that are already
            open, which may sign you out.
          </p>
          {settings.updated_at && settings.updated_by && (
            <p className="text-xs text-muted-foreground">
              Last changed <RelativeTime date={new Date(settings.updated_at)} /> by{' '}
              {settings.updated_by.display_name}
            </p>
          )}
          {!isOwner && (
            <p className="text-xs text-muted-foreground">Only an owner can change this.</p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {isOwner && (
            <div className="flex justify-end">
              <Button type="submit" disabled={!changed || save.isPending}>
                {save.isPending ? 'Saving…' : 'Save duration'}
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  )
}
