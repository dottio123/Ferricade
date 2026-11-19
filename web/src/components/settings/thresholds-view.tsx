import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import { useMe } from '@/auth/session'
import { ErrorState } from '@/components/brand/error-state'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/page-header'
import { queryKeys } from '@/lib/queryKeys'
import { ShieldAlertIcon } from 'lucide-react'

interface ThresholdsFormProps {
  initial: {
    offline_days: number
    pending_hours: number
    min_client_version: string
  }
  isOwner: boolean
}

function ThresholdsForm({ initial, isOwner }: ThresholdsFormProps) {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [offlineDays, setOfflineDays] = React.useState(initial.offline_days)
  const [pendingHours, setPendingHours] = React.useState(initial.pending_hours)
  const [minClientVersion, setMinClientVersion] = React.useState(initial.min_client_version)
  const [error, setError] = React.useState<string | null>(null)

  const updateMutation = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT('/admin/api/v1/settings/dashboard', {
          body: {
            offline_days: Number(offlineDays),
            pending_hours: Number(pendingHours),
            min_client_version: minClientVersion.trim(),
          },
        }),
      ),
    onSuccess: (saved) => {
      setError(null)
      setOfflineDays(saved.offline_days)
      setPendingHours(saved.pending_hours)
      setMinClientVersion(saved.min_client_version)
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboardSettings() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.summary() })
      toast({ title: 'Dashboard thresholds saved' })
    },
    onError: (err) => {
      setError(describeError(err).message)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isOwner) return
    setError(null)
    updateMutation.mutate()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Fleet attention thresholds</CardTitle>
        <CardDescription className="text-xs">
          Configure when devices trigger warnings and appear in the &ldquo;Needs attention&rdquo;
          module.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!isOwner && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <ShieldAlertIcon className="size-4 shrink-0 text-muted-foreground" />
            <span>
              Only owners can edit fleet thresholds. Values are displayed in read-only mode.
            </span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="threshold-offline-days"
                className="text-xs font-medium text-muted-foreground"
              >
                Offline attention threshold (days)
              </label>
              <Input
                id="threshold-offline-days"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'threshold-error' : undefined}
                type="number"
                min={1}
                max={365}
                value={offlineDays}
                onChange={(e) => setOfflineDays(Number(e.target.value))}
                disabled={!isOwner || updateMutation.isPending}
                required
              />
              <span className="text-xs text-muted-foreground">
                Devices offline longer than this trigger attention warnings (1–365 days).
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="threshold-pending-hours"
                className="text-xs font-medium text-muted-foreground"
              >
                Pending attention threshold (hours)
              </label>
              <Input
                id="threshold-pending-hours"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'threshold-error' : undefined}
                type="number"
                min={1}
                max={720}
                value={pendingHours}
                onChange={(e) => setPendingHours(Number(e.target.value))}
                disabled={!isOwner || updateMutation.isPending}
                required
              />
              <span className="text-xs text-muted-foreground">
                Devices waiting for approval longer than this trigger attention (1–720 hours).
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="threshold-min-version"
              className="text-xs font-medium text-muted-foreground"
            >
              Minimum RustDesk client version
            </label>
            <Input
              id="threshold-min-version"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'threshold-error' : undefined}
              type="text"
              placeholder="e.g. 1.4.0 (leave blank to disable)"
              value={minClientVersion}
              onChange={(e) => setMinClientVersion(e.target.value)}
              disabled={!isOwner || updateMutation.isPending}
              pattern="^(\d+(\.\d+){0,3})?$"
            />
            <span className="text-xs text-muted-foreground">
              Devices running older client versions are flagged for updates. Leave blank to disable
              version check.
            </span>
          </div>

          {error && (
            <p id="threshold-error" role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          {isOwner && (
            <div className="flex justify-end pt-2">
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? 'Saving…' : 'Save thresholds'}
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  )
}

export function ThresholdsView() {
  const { data: me } = useMe()
  const isOwner = me?.user.role === 'owner'

  const {
    data: thresholds,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.dashboardSettings(),
    queryFn: () => unwrap(api.GET('/admin/api/v1/settings/dashboard')),
  })

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <PageHeader
        title="Fleet Thresholds"
        description="Configure alerting thresholds for offline and pending devices."
        backLink={{ to: '/settings', label: 'Back to Settings' }}
      />

      {isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : error ? (
        <ErrorState
          title="Failed to load fleet thresholds"
          error={error}
          retry={() => void refetch()}
        />
      ) : thresholds ? (
        <ThresholdsForm initial={thresholds} isOwner={isOwner} />
      ) : null}
    </div>
  )
}
