import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import { useMe } from '@/auth/session'
import { CopyField } from '@/components/brand/copy-field'
import { ErrorState } from '@/components/brand/error-state'
import { ServerChecks, type Check } from '@/components/server/server-checks'
import { serverHostWarning, serverHostWithoutPort } from '@/components/server/server-host-hint'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'
import { useToast } from '@/components/ui/toast'
import { queryKeys } from '@/lib/queryKeys'
import { PlayIcon, ShieldAlertIcon } from 'lucide-react'

const KEY_COMMAND =
  "docker compose --env-file deploy/.env -f deploy/compose.yml logs hbbs | grep -A1 'Key:'"

interface ServerFormProps {
  initial: {
    name: string
    id_host: string
    relay_host: string
    public_key: string
    api_url: string
    links_include_server: boolean
  }
  isOwner: boolean
}

function ServerForm({ initial, isOwner }: ServerFormProps) {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [name, setName] = React.useState(initial.name)
  const [idHost, setIdHost] = React.useState(initial.id_host)
  const [relayHost, setRelayHost] = React.useState(initial.relay_host)
  const [publicKey, setPublicKey] = React.useState(initial.public_key)
  const [apiUrl, setApiUrl] = React.useState(initial.api_url)
  const [linksIncludeServer, setLinksIncludeServer] = React.useState(initial.links_include_server)
  const [keyError, setKeyError] = React.useState<string | null>(null)
  const [generalError, setGeneralError] = React.useState<string | null>(null)

  const [checks, setChecks] = React.useState<Check[] | null>(null)
  const idHostWarning = serverHostWarning(idHost)
  const relayHostWarning = serverHostWarning(relayHost)

  const updateMutation = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH('/admin/api/v1/server', {
          body: {
            name: name.trim() || undefined,
            id_host: idHost.trim(),
            relay_host: relayHost.trim(),
            public_key: publicKey.trim(),
            api_url: apiUrl.trim(),
            links_include_server: linksIncludeServer,
          },
        }),
      ),
    onSuccess: (saved) => {
      setChecks(null)
      setKeyError(null)
      setGeneralError(null)
      setName(saved.name)
      setIdHost(saved.id_host)
      setRelayHost(saved.relay_host)
      setPublicKey(saved.public_key)
      setApiUrl(saved.api_url)
      setLinksIncludeServer(saved.links_include_server)
      void queryClient.invalidateQueries({ queryKey: queryKeys.server() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.clientConfig() })
      toast({ title: 'Server settings saved' })
    },
    onError: (err) => {
      const { code, message } = describeError(err)
      if (code === 'invalid_key') {
        setKeyError('Public key must be base64 of 32 bytes.')
        setGeneralError(null)
      } else {
        setKeyError(null)
        setGeneralError(message)
      }
    },
  })

  const checkMutation = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/api/v1/server/check')),
    onSuccess: (data) => {
      setChecks(data.checks)
    },
    onError: (err) => {
      toast({
        title: 'Reachability check failed',
        description: describeError(err).message,
        variant: 'destructive',
      })
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isOwner) return
    setKeyError(null)
    setGeneralError(null)
    updateMutation.mutate()
  }

  return (
    <div className="flex flex-col gap-6">
      {!isOwner && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <ShieldAlertIcon className="size-4 shrink-0 text-muted-foreground" />
          <span>Only owners can edit server settings. Values are displayed in read-only mode.</span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Server profile</CardTitle>
          <CardDescription className="text-xs">
            Connection endpoints and credentials used by clients to establish remote sessions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="server-name" className="text-xs font-medium text-muted-foreground">
                Profile name
              </label>
              <Input
                id="server-name"
                aria-invalid={Boolean(generalError)}
                aria-describedby={generalError ? 'server-general-error' : undefined}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!isOwner || updateMutation.isPending}
                placeholder="default"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="server-id-host"
                  className="text-xs font-medium text-muted-foreground"
                >
                  ID server host
                </label>
                <Input
                  id="server-id-host"
                  aria-invalid={Boolean(generalError)}
                  aria-describedby={generalError ? 'server-general-error' : undefined}
                  value={idHost}
                  onChange={(e) => setIdHost(e.target.value)}
                  disabled={!isOwner || updateMutation.isPending}
                  required
                />
                {idHostWarning && <p className="text-xs text-muted-foreground">{idHostWarning}</p>}
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="server-relay-host"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Relay server host
                </label>
                <Input
                  id="server-relay-host"
                  aria-invalid={Boolean(generalError)}
                  aria-describedby={generalError ? 'server-general-error' : undefined}
                  value={relayHost}
                  onChange={(e) => setRelayHost(e.target.value)}
                  disabled={!isOwner || updateMutation.isPending}
                  required
                />
                {relayHostWarning && (
                  <p className="text-xs text-muted-foreground">{relayHostWarning}</p>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="server-api-url" className="text-xs font-medium text-muted-foreground">
                Client API address
              </label>
              <Input
                id="server-api-url"
                aria-invalid={Boolean(generalError)}
                aria-describedby={generalError ? 'server-general-error' : 'server-api-url-help'}
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                disabled={!isOwner || updateMutation.isPending}
                placeholder="Leave blank for the default"
              />
              <p className="text-xs text-muted-foreground">
                Using {apiUrl.trim() || `http://${serverHostWithoutPort(idHost)}:21114`}
              </p>
              <p id="server-api-url-help" className="text-xs text-muted-foreground">
                Leave blank for http://&lt;ID server&gt;:21114. Use an https address when a TLS
                proxy serves the client API.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="server-public-key"
                className="text-xs font-medium text-muted-foreground"
              >
                Public key
              </label>
              <Input
                id="server-public-key"
                aria-invalid={Boolean(keyError || generalError)}
                aria-describedby={
                  keyError ? 'server-key-error' : generalError ? 'server-general-error' : undefined
                }
                value={publicKey}
                onChange={(e) => {
                  setPublicKey(e.target.value)
                  if (keyError) setKeyError(null)
                }}
                disabled={!isOwner || updateMutation.isPending}
                className="font-mono text-xs"
                required
              />
              {keyError && (
                <p id="server-key-error" role="alert" className="text-xs text-destructive">
                  {keyError}
                </p>
              )}
            </div>

            {isOwner && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-2 p-3">
                <p className="text-xs text-muted-foreground">
                  Find the public key in the hbbs container log:
                </p>
                <CopyField value={KEY_COMMAND} />
              </div>
            )}

            <div className="flex items-start gap-3">
              <Switch
                id="server-links-include-server"
                aria-describedby="server-links-include-server-help"
                checked={linksIncludeServer}
                onCheckedChange={setLinksIncludeServer}
                disabled={!isOwner || updateMutation.isPending}
              />
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="server-links-include-server"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Put the ID server and key in connect links
                </label>
                <p id="server-links-include-server-help" className="text-xs text-muted-foreground">
                  When on, connect links and commands include the ID server and key. When off, they
                  are plain rustdesk://&lt;id&gt; links that work only on clients already set up for
                  this server.
                </p>
              </div>
            </div>

            {generalError && (
              <p id="server-general-error" role="alert" className="text-xs text-destructive">
                {generalError}
              </p>
            )}

            {isOwner && (
              <div className="flex justify-end pt-2">
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      {/* Reachability Checks Section */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-sm font-semibold">Reachability checks</CardTitle>
            <CardDescription className="text-xs">
              Test network connectivity from this server to ID server and relay ports.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending}
            className="gap-1.5"
          >
            <PlayIcon className="size-3.5" />
            <span>{checkMutation.isPending ? 'Checking…' : 'Run checks'}</span>
          </Button>
        </CardHeader>
        <CardContent>
          {checks || checkMutation.isPending ? (
            <ServerChecks checks={checks} isRunning={checkMutation.isPending} />
          ) : (
            <p className="text-xs text-muted-foreground">
              Click &ldquo;Run checks&rdquo; to test connection reachability to the configured
              server endpoints.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export function ServerSettingsView() {
  const { data: me } = useMe()
  const isOwner = me?.user.role === 'owner'

  const {
    data: server,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.server(),
    queryFn: () => unwrap(api.GET('/admin/api/v1/server')),
  })

  return (
    <div className="flex flex-col gap-6 w-full max-w-3xl mx-auto">
      <PageHeader
        title="Server"
        description="Configure network hosts, cryptographic keys, and verify server reachability."
        backLink={{ to: '/settings', label: 'Back to Settings' }}
      />

      {isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : error ? (
        <ErrorState
          title="Failed to load server profile"
          error={error}
          retry={() => void refetch()}
        />
      ) : server ? (
        <ServerForm initial={server} isOwner={isOwner} />
      ) : null}
    </div>
  )
}
