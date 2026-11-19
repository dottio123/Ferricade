import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon, ExternalLinkIcon } from 'lucide-react'
import type { components } from '@/api/schema'
import { describeError } from '@/api/errors'
import { CopyField } from '@/components/brand/copy-field'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { queryKeys } from '@/lib/queryKeys'
import { useConnectLink } from '@/hooks/use-connect-link'

export function useDeviceConnect(deviceId: string) {
  const queryClient = useQueryClient()
  // Connect link state
  const [connectAction, setConnectAction] = React.useState<
    'connect' | 'file-transfer' | 'port-forward' | 'terminal'
  >('connect')
  const [forceRelay, setForceRelay] = React.useState(false)
  const {
    connect,
    isLoading: connectLoading,
    result: connectResult,
    error: connectError,
    clearError,
    clearResult,
    previewLoading,
    previewError,
  } = useConnectLink()
  const [linkOpen, setLinkOpen] = React.useState(false)

  const [lastConnectDeviceId, setLastConnectDeviceId] = React.useState(deviceId)
  if (deviceId !== lastConnectDeviceId) {
    setLastConnectDeviceId(deviceId)
    setLinkOpen(false)
    clearResult()
    clearError()
  }

  // The box fetches only while open, once per open and once per action or relay change.
  const fetchLink = React.useCallback(
    () =>
      connect(deviceId, {
        action: connectAction,
        relay: forceRelay,
        launch: false,
        onError: (error) => {
          if (describeError(error).code === 'access_locked') {
            setLinkOpen(false)
            clearResult()
            void queryClient.invalidateQueries({ queryKey: queryKeys.devicePolicy(deviceId) })
          }
        },
      }),
    [connect, deviceId, connectAction, forceRelay, clearResult, queryClient],
  )

  const handleConnect = () =>
    connect(deviceId, {
      action: connectAction,
      relay: forceRelay,
      onError: (error) => {
        if (describeError(error).code === 'access_locked') {
          clearResult()
          void queryClient.invalidateQueries({ queryKey: queryKeys.devicePolicy(deviceId) })
        }
      },
    })
  return {
    connectAction,
    setConnectAction,
    forceRelay,
    setForceRelay,
    connectLoading,
    connectResult,
    connectError,
    handleConnect,
    linkOpen,
    setLinkOpen,
    fetchLink,
    previewLoading,
    previewError,
  }
}

export function DeviceConnectSection({
  connection,
  policyStatus,
}: {
  connection: ReturnType<typeof useDeviceConnect>
  policyStatus: components['schemas']['DevicePolicyStatus'] | undefined
}) {
  const {
    connectAction,
    setConnectAction,
    forceRelay,
    setForceRelay,
    connectLoading,
    connectResult,
    connectError,
    handleConnect,
    linkOpen,
    setLinkOpen,
    fetchLink,
    previewLoading,
    previewError,
  } = connection
  const locked = policyStatus?.connect === 'locked'
  // Like the Connect button: nothing until the policy is known and not locked.
  const unavailable = locked || !policyStatus
  const open = linkOpen && !unavailable
  React.useEffect(() => {
    if (open) void fetchLink()
  }, [open, fetchLink])
  return (
    <div
      data-slot="device-connect"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Remote Connection</h3>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5 w-44">
          <label htmlFor="connect-action" className="text-xs font-medium text-muted-foreground">
            Action
          </label>
          <Select
            value={connectAction}
            onValueChange={(val) =>
              setConnectAction(val as 'connect' | 'file-transfer' | 'port-forward' | 'terminal')
            }
          >
            <SelectTrigger id="connect-action" className="w-full">
              <SelectValue placeholder="Action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="connect">Connect</SelectItem>
              <SelectItem value="file-transfer">File transfer</SelectItem>
              <SelectItem value="port-forward">Port forward</SelectItem>
              <SelectItem value="terminal">Terminal</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 pb-2">
          <Switch id="force-relay" checked={forceRelay} onCheckedChange={setForceRelay} />
          <label
            htmlFor="force-relay"
            className="text-xs font-medium text-foreground cursor-pointer select-none"
          >
            Force relay
          </label>
        </div>

        <div className="pb-0.5">
          <span
            title={
              policyStatus?.connect === 'locked'
                ? 'Locked by policy. Allow access first.'
                : undefined
            }
          >
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleConnect}
              disabled={connectLoading || !policyStatus || policyStatus.connect === 'locked'}
              title={
                policyStatus?.connect === 'locked'
                  ? 'Locked by policy. Allow access first.'
                  : undefined
              }
              className="gap-1.5"
            >
              <ExternalLinkIcon className="size-4" />
              {connectLoading ? 'Connecting…' : 'Connect'}
            </Button>
          </span>
        </div>
      </div>

      {policyStatus?.connect === 'locked' && (
        <p className="text-xs text-muted-foreground">Locked by policy. Allow access first.</p>
      )}
      {policyStatus?.connect === 'attended' && (
        <p className="text-xs text-muted-foreground">Someone at the device must accept.</p>
      )}
      {policyStatus?.connect === 'window' && policyStatus.status === 'pending' && (
        <p className="text-xs text-muted-foreground">Applying access…</p>
      )}

      {connectError && (
        <div className="mt-2 rounded-md border border-border bg-surface-2 p-3 text-xs">
          <div className="text-destructive font-medium">{connectError}</div>
        </div>
      )}

      <details
        data-slot="connect-link-box"
        open={open}
        className="group mt-2 rounded-md border border-border bg-surface-2 text-xs"
      >
        <summary
          aria-disabled={unavailable || undefined}
          title={locked ? 'Locked by policy. Allow access first.' : undefined}
          onClick={(event) => {
            // Controlled: the open state drives the fetch, not the native toggle.
            event.preventDefault()
            if (!unavailable) setLinkOpen(!linkOpen)
          }}
          className={`flex list-none items-center justify-between p-3 font-medium text-muted-foreground [&::-webkit-details-marker]:hidden ${
            unavailable ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
          }`}
        >
          <span>RustDesk Connect Link</span>
          <ChevronDownIcon className="size-4 transition-transform group-open:rotate-180" />
        </summary>
        <div className="flex flex-col gap-3 px-3 pb-3">
          {previewError ? (
            <div className="text-destructive font-medium">{previewError}</div>
          ) : previewLoading && !connectResult ? (
            <div className="text-muted-foreground">Getting link…</div>
          ) : connectResult ? (
            <>
              <div className="flex items-center justify-between">
                {/* Empty span keeps "Open in RustDesk" right-aligned when nothing is loading */}
                <span className="min-w-0 truncate text-muted-foreground font-medium">
                  {previewLoading ? 'Getting link…' : null}
                </span>
                <a
                  href={connectResult.url}
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-primary hover:underline font-semibold"
                >
                  <span>Open in RustDesk</span>
                  <ExternalLinkIcon className="size-3" />
                </a>
              </div>
              <CopyField label="Link" value={connectResult.url} />
              <CopyField label="Command" value={connectResult.command} />
              {!connectResult.includes_server && (
                <p className="text-xs text-muted-foreground">
                  Works only from a RustDesk client already set to this server and its key.
                </p>
              )}
            </>
          ) : null}
        </div>
      </details>
    </div>
  )
}
