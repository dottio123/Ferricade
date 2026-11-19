import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import { useMe } from '@/auth/session'
import { ErrorState } from '@/components/brand/error-state'
import { RelativeTime } from '@/components/brand/relative-time'
import { PageHeader } from '@/components/page-header'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { queryKeys } from '@/lib/queryKeys'
import { idAllowListQueryOptions } from '@/lib/queries'
import { deploymentProfileQueryKey } from './deployment-view'
import { PolicyEditor } from './policy-editor'
import { InfoIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import type { components } from '@/api/schema'

type Policy = components['schemas']['Policy']
type PolicyPush = components['schemas']['PolicyPush']

export function PoliciesView() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { data: me } = useMe()
  const role = me?.user.role
  const isOwner = role === 'owner'
  const allowListVisible = role === 'owner' || role === 'admin'
  const search = useSearch({ strict: false }) as { edit?: string }
  const editId = search?.edit

  // Push toggle confirm state
  const [pendingPushState, setPendingPushState] = React.useState<boolean | null>(null)
  const [pushError, setPushError] = React.useState<string | null>(null)

  // Policy delete state
  const [policyToDelete, setPolicyToDelete] = React.useState<Policy | null>(null)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)

  // 1. Fetch policy push status
  const pushQuery = useQuery({
    queryKey: queryKeys.policyPush(),
    queryFn: () => unwrap(api.GET('/admin/api/v1/settings/policy-push')),
  })

  // 2. Fetch policies list
  const policiesQuery = useQuery({
    queryKey: queryKeys.policies(),
    queryFn: () => unwrap(api.GET('/admin/api/v1/policies')),
  })

  // 3. Fetch deployment profile for catalog
  const profileQuery = useQuery({
    queryKey: deploymentProfileQueryKey,
    queryFn: () => unwrap(api.GET('/admin/api/v1/deployment/profile')),
  })

  // 4. Fetch global ID allow list (owner/admin only; hidden on error/loading)
  const allowListQuery = useQuery({
    ...idAllowListQueryOptions,
    enabled: allowListVisible,
    retry: false,
  })

  // Mutation: set policy push
  const pushMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      return unwrap(
        api.PUT('/admin/api/v1/settings/policy-push', {
          body: { enabled },
        }),
      )
    },
    onSuccess: (updated) => {
      setPushError(null)
      setPendingPushState(null)
      queryClient.setQueryData(queryKeys.policyPush(), updated)
      void queryClient.invalidateQueries({ queryKey: queryKeys.policyPush() })
      toast({ title: updated.enabled ? 'Policy push enabled' : 'Policy push disabled' })
    },
    onError: (err) => {
      const desc = describeError(err)
      setPushError(desc.message)
      setPendingPushState(null)
    },
  })

  // Mutation: delete policy
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return unwrap(
        api.DELETE('/admin/api/v1/policies/{id}', {
          params: { path: { id } },
        }),
      )
    },
    onSuccess: () => {
      setDeleteError(null)
      setPolicyToDelete(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.policies() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups() })
    },
    onError: (err) => {
      const desc = describeError(err)
      if (desc.code === 'in_use') {
        setDeleteError(
          'This policy is used by a group. Choose another policy for those groups first.',
        )
      } else {
        setDeleteError(desc.message)
      }
    },
  })

  const handlePushToggle = (checked: boolean) => {
    setPushError(null)
    setPendingPushState(checked)
  }

  const handleConfirmPush = () => {
    if (pendingPushState === null) return
    pushMutation.mutate(pendingPushState)
  }

  const handleDeletePolicy = () => {
    if (!policyToDelete) return
    deleteMutation.mutate(policyToDelete.id)
  }

  const catalog = profileQuery.data?.catalog ?? []
  const policies = React.useMemo(() => policiesQuery.data?.items ?? [], [policiesQuery.data?.items])
  const policyPush = pushQuery.data as PolicyPush | undefined

  const isLoading = pushQuery.isLoading || policiesQuery.isLoading || profileQuery.isLoading

  // Handle unknown policy edit id
  React.useEffect(() => {
    if (isLoading || !editId || editId === 'new') return
    const exists = policies.some((p) => p.id === editId)
    if (!exists) {
      toast({
        title: 'Policy not found',
        variant: 'destructive',
      })
      void navigate({ to: '/policies', replace: true })
    }
  }, [isLoading, editId, policies, navigate, toast])

  const editingPolicy = React.useMemo(() => {
    if (!editId) return null
    if (editId === 'new') return undefined
    return policies.find((p) => p.id === editId) ?? null
  }, [editId, policies])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 w-full max-w-4xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
        <div className="flex flex-col gap-4 mt-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  if (pushQuery.error || policiesQuery.error || profileQuery.error) {
    const error = pushQuery.error || policiesQuery.error || profileQuery.error
    return (
      <div className="flex flex-col gap-6 w-full max-w-4xl mx-auto">
        <PageHeader
          title="Client Policies"
          description="Configure client settings profiles and push policies to approved devices."
        />
        <ErrorState
          title="Failed to load client policies"
          error={error}
          retry={() => {
            void pushQuery.refetch()
            void policiesQuery.refetch()
            void profileQuery.refetch()
          }}
        />
      </div>
    )
  }

  // Show Editor when editing or creating
  if (editingPolicy !== null) {
    return (
      <div className="flex flex-col gap-6 w-full max-w-4xl mx-auto">
        <PageHeader
          title={editingPolicy ? `Edit ${editingPolicy.name}` : 'New Client Policy'}
          description="Configure baseline access security and client settings for RustDesk endpoints."
          backLink={{ to: '/policies', label: 'Policies' }}
        />
        <PolicyEditor
          policy={editingPolicy}
          catalog={catalog}
          onClose={() => void navigate({ to: '/policies' })}
          onSaved={() => void navigate({ to: '/policies' })}
        />
      </div>
    )
  }

  const lastUpdatedBy = policyPush?.updated_by?.display_name || policyPush?.updated_by?.id

  return (
    <div className="flex flex-col gap-6 w-full max-w-4xl mx-auto">
      <PageHeader
        title="Client Policies"
        description="Configure client settings profiles and push policies to approved devices."
        actions={
          <Button
            onClick={() => void navigate({ to: '/policies', search: { edit: 'new' } })}
            size="sm"
            className="gap-1.5"
          >
            <PlusIcon className="size-4" />
            <span>New policy</span>
          </Button>
        }
      />

      {/* ID allow list notice (owner/admin only, hidden while loading or on error) */}
      {allowListVisible && !allowListQuery.error && allowListQuery.data && (
        <div
          data-slot="id-allow-list-notice"
          className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground leading-relaxed"
        >
          <InfoIcon className="size-4 shrink-0 text-muted-foreground mt-0.5" aria-hidden="true" />
          <p>
            ID allow lists are sent with policies while push is on. Global ID Allowlist:{' '}
            {allowListQuery.data.ids.length === 0
              ? 'empty (any ID can connect)'
              : allowListQuery.data.ids.length === 1
                ? '1 ID'
                : `${allowListQuery.data.ids.length} IDs`}
            . Group and device lists add to it.{' '}
            <Link
              to="/settings/id-allow-list"
              className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
            >
              Edit the Global ID Allowlist
            </Link>
          </p>
        </div>
      )}

      {/* Push Error Message */}
      {pushError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive flex items-center justify-between"
        >
          <span>{pushError}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPushError(null)}
            className="h-6 px-2 text-2xs"
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* 1. Policy Push Switch Card */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-sm font-semibold">Policy push</CardTitle>
              <CardDescription className="text-xs mt-1 leading-relaxed">
                Automatically push group policies to approved devices during regular heartbeats.
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="policy-push-switch"
                aria-label="Policy push"
                checked={policyPush?.enabled ?? false}
                onCheckedChange={handlePushToggle}
                disabled={!isOwner || pushMutation.isPending}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-wrap items-center justify-between text-xs text-muted-foreground border-t border-border/50 pt-3 gap-2">
            <div>
              {policyPush?.updated_at ? (
                <span>
                  Last changed <RelativeTime date={policyPush.updated_at} />
                  {lastUpdatedBy ? ` by ${lastUpdatedBy}` : ''}
                </span>
              ) : (
                <span>Last changed: never</span>
              )}
            </div>
            {!isOwner && (
              <span className="text-muted-foreground font-medium">
                Only the owner can change this.
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 2. Policies List Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Policies</CardTitle>
          <CardDescription className="text-xs">
            Policies define security baselines and client configuration. Each group can assign a
            policy or inherit from its parent.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border/60">
            {policies.map((p) => {
              const managedCount = Object.keys(p.settings).length
              const updatedBy = p.updated_by?.display_name || p.updated_by?.id

              return (
                <div
                  key={p.id}
                  data-slot={`policy-row-${p.id}`}
                  className="flex items-center justify-between p-4 transition-colors hover:bg-muted/20"
                >
                  <div className="flex flex-col gap-1 min-w-0 pr-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">{p.name}</span>
                      {p.is_default && <Badge variant="secondary">Default</Badge>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>
                        {managedCount === 1
                          ? '1 setting managed'
                          : `${managedCount} settings managed`}
                      </span>
                      <span>·</span>
                      <span>
                        Updated <RelativeTime date={p.updated_at} />
                        {updatedBy ? ` by ${updatedBy}` : ''}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void navigate({ to: '/policies', search: { edit: p.id } })}
                      aria-label={`Edit ${p.name}`}
                      className="gap-1.5 h-8 text-xs"
                    >
                      <PencilIcon className="size-3.5" />
                      <span>Edit</span>
                    </Button>

                    {!p.is_default && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setDeleteError(null)
                          setPolicyToDelete(p)
                        }}
                        aria-label={`Delete ${p.name}`}
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Confirmation Dialog: Turn ON Policy Push */}
      <Dialog
        open={pendingPushState === true}
        onOpenChange={(open) => !open && setPendingPushState(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Turn on policy push?</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed pt-2 text-foreground">
              Approved devices apply their policy&apos;s settings within about 15 seconds. Managed
              settings override values set on the device or by a deployment script.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingPushState(null)}
              disabled={pushMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleConfirmPush} disabled={pushMutation.isPending}>
              {pushMutation.isPending ? 'Turning on…' : 'Turn on'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog: Turn OFF Policy Push */}
      <Dialog
        open={pendingPushState === false}
        onOpenChange={(open) => !open && setPendingPushState(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Turn off policy push?</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed pt-2 text-foreground">
              Devices keep the settings they last received. Ferricade stops managing them until you
              turn this on again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingPushState(null)}
              disabled={pushMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleConfirmPush}
              disabled={pushMutation.isPending}
            >
              {pushMutation.isPending ? 'Turning off…' : 'Turn off'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={Boolean(policyToDelete)}
        onOpenChange={(open) => {
          if (!open) {
            setPolicyToDelete(null)
            setDeleteError(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete policy?</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed pt-2">
              Are you sure you want to delete &ldquo;{policyToDelete?.name}&rdquo;? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>

          {deleteError && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
            >
              {deleteError}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPolicyToDelete(null)
                setDeleteError(null)
              }}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDeletePolicy}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete policy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
