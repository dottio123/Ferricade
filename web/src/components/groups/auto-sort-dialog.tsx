import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangleIcon, CheckCircle2Icon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import type { components } from '@/api/schema'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { queryKeys } from '@/lib/queryKeys'

type AutoSortResult = components['schemas']['AutoSortResult']

export interface AutoSortDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function AutoSortDialogContent({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [understood, setUnderstood] = React.useState(false)
  const [runResult, setRunResult] = React.useState<AutoSortResult | null>(null)
  const [runError, setRunError] = React.useState<string | null>(null)

  // Load the dry-run preview
  const previewQuery = useQuery<AutoSortResult>({
    queryKey: ['devices', 'auto-sort', 'preview'],
    queryFn: () => unwrap(api.POST('/admin/api/v1/devices/auto-sort/preview')),
    enabled: runResult === null,
  })

  // Run mutation
  const runMutation = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/api/v1/devices/auto-sort')),
    onSuccess: (result: AutoSortResult) => {
      setRunResult(result)
      setRunError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
    },
    onError: (err) => {
      const desc = describeError(err)
      if (desc.code === 'busy') {
        setRunError('devices are busy, try again')
      } else {
        setRunError(desc.message)
      }
    },
  })

  const preview = previewQuery.data
  const moves = preview?.moves ?? []
  const conflicts = preview?.conflicts ?? []
  const unchanged = preview?.unchanged ?? 0

  const handleClose = () => {
    if (!runMutation.isPending) {
      onClose()
    }
  }

  const handleConfirmRun = () => {
    if (!understood || runMutation.isPending) return
    runMutation.mutate()
  }

  const movesText = `${moves.length} ${moves.length === 1 ? 'device will move' : 'devices will move'}`
  const conflictsText = `${conflicts.length} ${conflicts.length === 1 ? 'conflict' : 'conflicts'}`
  const unchangedText = `${unchanged} unchanged`
  const summaryText = `${movesText}, ${conflictsText}, ${unchangedText}`

  return (
    <DialogContent data-slot="auto-sort-dialog" className="sm:max-w-xl max-h-[85vh] flex flex-col">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-destructive-text">
          <AlertTriangleIcon className="size-5 shrink-0" />
          <span>Auto Sort All</span>
        </DialogTitle>
        <DialogDescription className="text-xs leading-relaxed text-muted-foreground pt-1">
          Auto sort moves approved devices into the group their name matches, even devices you
          placed by hand. Moved devices take the client policy of their new group. Devices matching
          several groups are flagged, not moved. This cannot be undone; every move is in the audit
          log.
        </DialogDescription>
      </DialogHeader>

      <div className="flex-1 overflow-y-auto py-2 space-y-3 min-h-0 text-xs">
        {/* If the run already completed, show summary result */}
        {runResult !== null ? (
          <div className="flex flex-col gap-3 py-4">
            <div className="flex items-center gap-2 text-primary font-medium text-sm">
              <CheckCircle2Icon className="size-5 shrink-0" />
              <span>Auto sort complete</span>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1.5 font-mono text-2xs">
              <div>Moved: {runResult.moves.length} devices</div>
              <div>Conflicts flagged: {runResult.conflicts.length} devices</div>
              <div>Unchanged: {runResult.unchanged} devices</div>
            </div>
          </div>
        ) : previewQuery.isLoading ? (
          <div className="flex flex-col gap-3 py-4">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : previewQuery.isError ? (
          <div className="p-3 text-destructive-text bg-destructive-text/10 rounded-md border border-destructive-text/20">
            {describeError(previewQuery.error).message}
          </div>
        ) : (
          <>
            {/* Counts summary banner */}
            <div className="rounded-md border border-border bg-muted/30 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 font-mono text-2xs">
              <span className="font-semibold text-foreground font-sans text-xs">
                Planned Changes
              </span>
              <span className="font-semibold text-foreground">{summaryText}</span>
            </div>

            {/* List of moves */}
            {moves.length > 0 && (
              <div className="space-y-1.5">
                <div className="font-semibold text-foreground text-xs">
                  Devices that will be moved ({moves.length}):
                </div>
                <div className="max-h-40 overflow-y-auto border border-border/60 rounded-md divide-y divide-border/40">
                  {moves.map((m) => (
                    <div
                      key={m.device.id}
                      className="p-2 flex items-center justify-between text-2xs font-mono bg-background/50 gap-2"
                    >
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-foreground font-medium truncate">
                          {m.device.hostname || m.device.rustdesk_id}
                        </span>
                        <span className="text-muted-foreground text-3xs font-sans">
                          Current: {m.from_group?.name || 'No group'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 font-sans shrink-0">
                        <span className="text-muted-foreground text-3xs">→</span>
                        <Badge variant="outline" className="text-3xs py-0 truncate max-w-[120px]">
                          {m.to_group.name}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* List of conflicts */}
            {conflicts.length > 0 && (
              <div className="space-y-1.5">
                <div className="font-semibold text-status-alert text-xs">
                  Conflicts that will be flagged ({conflicts.length}):
                </div>
                <div className="max-h-36 overflow-y-auto border border-status-alert/30 rounded-md divide-y divide-status-alert/20 bg-status-alert/5">
                  {conflicts.map((c) => (
                    <div key={c.device.id} className="p-2 flex flex-col gap-0.5 text-2xs font-mono">
                      <span className="text-foreground font-medium truncate">
                        {c.device.hostname || c.device.rustdesk_id}
                      </span>
                      <span className="text-muted-foreground font-sans text-3xs break-words">
                        Matches: {c.groups.map((g) => g.name).join(', ')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {moves.length === 0 && (
              <div className="p-3 text-center text-muted-foreground italic border border-dashed rounded-md">
                No approved devices will be moved. All devices are already in their matched groups
                or have no matching pattern.
              </div>
            )}

            {/* Confirmation checkbox required if there are moves */}
            {moves.length > 0 && (
              <div className="pt-2 border-t border-border">
                <label className="flex items-start gap-2.5 p-2 rounded-md hover:bg-muted/40 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={understood}
                    onChange={(e) => setUnderstood(e.target.checked)}
                    className="mt-0.5 size-4 rounded-xs border-border text-primary accent-primary cursor-pointer shrink-0"
                  />
                  <span className="text-2xs font-medium text-foreground leading-snug">
                    I understand these devices will move and may get a different client policy
                  </span>
                </label>
              </div>
            )}

            {/* Run error display */}
            {runError && (
              <p role="alert" className="text-2xs text-destructive-text font-medium">
                {runError}
              </p>
            )}
          </>
        )}
      </div>

      <DialogFooter className="mt-2">
        {runResult !== null || moves.length === 0 ? (
          <Button
            type="button"
            onClick={handleClose}
            className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
          >
            Close
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={runMutation.isPending}
              className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleConfirmRun}
              disabled={!understood || runMutation.isPending}
              className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
            >
              {runMutation.isPending ? 'Sorting…' : 'Auto sort all'}
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  )
}

export function AutoSortDialog({ open, onOpenChange }: AutoSortDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <AutoSortDialogContent onClose={() => onOpenChange(false)} />}
    </Dialog>
  )
}
