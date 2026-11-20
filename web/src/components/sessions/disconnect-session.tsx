import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2Icon, UnplugIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { ApiError, describeError } from '@/api/errors'
import type { components } from '@/api/schema'
import { useRole } from '@/auth/role'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { queryKeys } from '@/lib/queryKeys'

type RemoteSession = components['schemas']['RemoteSession']

/** What an ended session with end_reason "disconnected" is called wherever end reasons show. */
export const DISCONNECTED_LABEL = 'Disconnected by an administrator'

export interface DisconnectSessionProps {
  session: RemoteSession
  /** An icon-only button, for rows with little room. */
  compact?: boolean
}

/**
 * Disconnect control for one session row (POST /sessions/{id}/disconnect): a button on an open
 * session, "Disconnecting…" once a disconnect was requested, nothing when the session has ended or
 * the account is a User. The live session events end the request state.
 */
export function DisconnectSession({ session, compact = false }: DisconnectSessionProps) {
  const role = useRole()
  if (session.ended_at !== null || (role !== 'owner' && role !== 'admin')) return null
  if (session.disconnect_requested_at !== null) {
    return (
      <span
        data-slot="session-disconnecting"
        title={`Disconnect requested ${new Date(session.disconnect_requested_at).toLocaleString()}`}
        className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground"
      >
        <Loader2Icon className="size-3 animate-spin" aria-hidden />
        Disconnecting…
      </span>
    )
  }
  return <DisconnectButton session={session} compact={compact} />
}

function DisconnectButton({ session, compact }: { session: RemoteSession; compact: boolean }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [open, setOpen] = React.useState(false)
  const peer = session.peer_name || session.peer_rustdesk_id || 'The peer'
  const device = session.device_name || 'this device'
  const label = `Disconnect ${session.peer_name || session.peer_rustdesk_id || 'peer'} from ${
    session.device_name || 'device'
  }`

  const mutation = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/admin/api/v1/sessions/{id}/disconnect', {
          params: { path: { id: session.id } },
        }),
      ),
    onSuccess: () => setOpen(false),
    onError: (err) => {
      setOpen(false)
      if (err instanceof ApiError && err.code === 'session_ended') {
        toast({ title: 'This session has already ended.' })
        return
      }
      toast({
        title: 'Could not disconnect the session',
        description: describeError(err).message,
        variant: 'destructive',
      })
    },
    // The request state and the ended state both come from the server.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all() }),
  })

  return (
    <>
      {compact ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:size-[var(--control-height-sm,1.75rem)] text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-destructive"
              onClick={() => setOpen(true)}
            >
              <UnplugIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Disconnect</TooltipContent>
        </Tooltip>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={label}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-destructive"
          onClick={() => setOpen(true)}
        >
          <UnplugIcon className="size-3.5" />
          Disconnect
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!mutation.isPending) setOpen(next)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect this session?</DialogTitle>
            <DialogDescription>
              {peer} will be disconnected from {device}. It may take a few seconds.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              autoFocus
              onClick={() => setOpen(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              <UnplugIcon className="size-3.5" />
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
