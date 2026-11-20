import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import {
  LockKeyholeIcon,
  MonitorCheckIcon,
  MoreHorizontalIcon,
  PencilIcon,
  ShieldAlertIcon,
  UnlinkIcon,
  UserPlusIcon,
} from 'lucide-react'
import { useMe } from '@/auth/session'
import { EmptyState } from '@/components/brand/empty-state'
import { ErrorState } from '@/components/brand/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/page-header'
import { UserAvatar } from '@/components/user-avatar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { queryKeys } from '@/lib/queryKeys'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useAllUsers, type User } from '@/features/audit/actor'
import { AssignDevicesDialog } from './assign-devices-dialog'
import { UserResetPasswordDialog } from './reset-password-dialog'
import { UserCreateDialog, UserEditDialog, UserResetTotpDialog } from './user-dialogs'

export interface UserMoreActionsMenuProps {
  user: User
  isOwner: boolean
  isSelf: boolean
  onResetTotp: (user: User) => void
  onResetPassword: (user: User) => void
  onUnlinkSso: (user: User) => void
  triggerClassName?: string
}

export function UserMoreActionsMenu({
  user,
  isOwner,
  isSelf,
  onResetTotp,
  onResetPassword,
  onUnlinkSso,
  triggerClassName,
}: UserMoreActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={
            triggerClassName ??
            'h-8 w-8 p-0 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-muted-foreground hover:text-foreground'
          }
          aria-label={`More actions for ${user.username}`}
        >
          <MoreHorizontalIcon className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem className="pointer-coarse:min-h-11" onSelect={() => onResetTotp(user)}>
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <span>Reset 2FA</span>
        </DropdownMenuItem>
        {isOwner && !isSelf && (
          <DropdownMenuItem
            className="pointer-coarse:min-h-11"
            onSelect={() => onResetPassword(user)}
          >
            <LockKeyholeIcon className="size-4" aria-hidden="true" />
            <span>Reset password</span>
          </DropdownMenuItem>
        )}
        {user.sso && (
          <DropdownMenuItem
            variant="destructive"
            className="pointer-coarse:min-h-11"
            onSelect={() => onUnlinkSso(user)}
          >
            <UnlinkIcon className="size-4" aria-hidden="true" />
            <span>Unlink SSO</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UserBadges({
  user,
  isSelf,
  placement,
}: {
  user: User
  isSelf: boolean
  placement: 'mobile' | 'table' | 'compact'
}) {
  if (placement === 'table')
    return (
      <>
        {isSelf && (
          <Badge variant="outline" className="text-2xs h-4 px-1 text-muted-foreground">
            You
          </Badge>
        )}
        {user.sso && (
          <Badge variant="secondary" className="text-2xs">
            SSO
          </Badge>
        )}
      </>
    )
  if (placement === 'compact')
    return (
      <>
        <Badge variant="secondary" className="text-xs capitalize font-medium">
          {user.role}
        </Badge>
        <Badge
          variant={user.status === 'active' ? 'online' : 'alert'}
          className="text-xs capitalize"
        >
          {user.status}
        </Badge>
        <Badge variant="outline" className="text-xs text-muted-foreground font-normal">
          {user.totp_required ? '2FA required' : '2FA optional'}
        </Badge>
      </>
    )
  return (
    <>
      {isSelf && (
        <Badge variant="outline" className="text-2xs h-5 px-1.5 text-muted-foreground">
          You
        </Badge>
      )}
      <Badge variant="secondary" className="text-xs capitalize font-medium">
        {user.role}
      </Badge>
      <Badge variant={user.status === 'active' ? 'online' : 'alert'} className="text-xs capitalize">
        {user.status}
      </Badge>
      {user.sso && (
        <Badge variant="secondary" className="text-2xs">
          SSO
        </Badge>
      )}
      <Badge variant="outline" className="text-xs text-muted-foreground font-normal">
        {user.totp_required ? '2FA required' : '2FA optional'}
      </Badge>
    </>
  )
}

function UserPrimaryActions({
  user,
  isOwner,
  layout,
  onEdit,
  onAssign,
}: {
  user: User
  isOwner: boolean
  layout: 'mobile' | 'table'
  onEdit: () => void
  onAssign: () => void
}) {
  const edit = (
    <Button
      variant="ghost"
      size="sm"
      onClick={onEdit}
      className={
        layout === 'mobile'
          ? 'min-h-11 pointer-coarse:min-h-11 px-3 text-xs gap-1.5 text-muted-foreground hover:text-foreground'
          : 'h-8 w-8 px-0 lg:w-auto lg:px-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-xs gap-1 text-muted-foreground hover:text-foreground'
      }
      aria-label={`Edit user ${user.username}`}
    >
      <PencilIcon className="size-3.5" aria-hidden={layout === 'table' ? true : undefined} />
      <span className={layout === 'table' ? 'hidden lg:inline' : undefined}>Edit</span>
    </Button>
  )
  const assign = (
    <Button
      variant="ghost"
      size="sm"
      onClick={onAssign}
      className={
        layout === 'mobile'
          ? 'min-h-11 pointer-coarse:min-h-11 px-3 text-xs gap-1.5 text-muted-foreground hover:text-foreground'
          : 'h-8 w-8 px-0 lg:w-auto lg:px-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-xs gap-1 text-muted-foreground hover:text-foreground'
      }
      aria-label={`Assign devices to ${user.username}`}
    >
      <MonitorCheckIcon className="size-3.5" aria-hidden={layout === 'table' ? true : undefined} />
      <span className={layout === 'table' ? 'hidden lg:inline' : undefined}>Assign devices</span>
    </Button>
  )
  return (
    <>
      {layout === 'table' ? (
        <Tooltip>
          <TooltipTrigger asChild>{edit}</TooltipTrigger>
          <TooltipContent className="lg:hidden">Edit</TooltipContent>
        </Tooltip>
      ) : (
        edit
      )}
      {isOwner &&
        user.role === 'user' &&
        (layout === 'table' ? (
          <Tooltip>
            <TooltipTrigger asChild>{assign}</TooltipTrigger>
            <TooltipContent className="lg:hidden">Assign devices</TooltipContent>
          </Tooltip>
        ) : (
          assign
        ))}
    </>
  )
}

export function UsersView() {
  const me = useMe().data
  const isOwner = me?.user.role === 'owner'
  const currentUserId = me?.user.id
  const { toast } = useToast()

  const [createOpen, setCreateOpen] = React.useState(false)
  const [editingUser, setEditingUser] = React.useState<User | null>(null)
  const [editOpen, setEditOpen] = React.useState(false)
  const [resetTotpUser, setResetTotpUser] = React.useState<User | null>(null)
  const [resetTotpOpen, setResetTotpOpen] = React.useState(false)
  const [resetPasswordUser, setResetPasswordUser] = React.useState<User | null>(null)
  const [assignUser, setAssignUser] = React.useState<User | null>(null)
  const [unlinkUser, setUnlinkUser] = React.useState<User | null>(null)
  const [unlinkError, setUnlinkError] = React.useState<string | null>(null)
  const queryClient = useQueryClient()
  const unlink = useMutation({
    mutationFn: (user: User) =>
      unwrap(api.DELETE('/admin/api/v1/users/{id}/oidc', { params: { path: { id: user.id } } })),
    onSuccess: (_data, user) => {
      setUnlinkUser(null)
      setUnlinkError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all() })
      toast({ title: `SSO unlinked for ${user.username}` })
    },
    onError: (error) => {
      const info = describeError(error)
      setUnlinkError(
        info.code === 'no_password'
          ? 'This user has no password, so unlinking would lock them out.'
          : info.message,
      )
    },
  })

  // Fetch all users (only runs if isOwner is true)
  const usersQuery = useAllUsers(isOwner)
  const users = usersQuery.data ?? []

  const handleEdit = (user: User) => {
    setEditingUser(user)
    setEditOpen(true)
  }

  const handleResetTotp = (user: User) => {
    setResetTotpUser(user)
    setResetTotpOpen(true)
  }

  const handleOpenUnlink = (user: User) => {
    setUnlinkError(null)
    setUnlinkUser(user)
  }

  return (
    <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto" data-slot="users-page">
      <PageHeader
        title="Users"
        description="Manage accounts, roles, status, two-factor authentication, and SSO."
        backLink={{ to: '/settings', label: 'Back to Settings' }}
        actions={
          <Button
            onClick={() => setCreateOpen(true)}
            size="sm"
            className="gap-1.5 min-h-[44px] sm:min-h-0 h-11 sm:h-8 pointer-coarse:min-h-11"
          >
            <UserPlusIcon className="size-4" />
            <span>New user</span>
          </Button>
        }
      />

      {/* Main Content */}
      {usersQuery.isLoading ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : usersQuery.isError ? (
        <ErrorState error={usersQuery.error} retry={() => void usersQuery.refetch()} />
      ) : users.length === 0 ? (
        <EmptyState
          title="No users found"
          description="Create accounts for administrators and owners who manage Ferricade."
          action={
            <Button
              onClick={() => setCreateOpen(true)}
              size="sm"
              className="gap-1.5 min-h-[44px] sm:min-h-0 h-11 sm:h-8 pointer-coarse:min-h-11"
            >
              <UserPlusIcon className="size-4" />
              <span>Create first user</span>
            </Button>
          }
        />
      ) : (
        <>
          <div className="md:hidden flex flex-col gap-2.5" data-slot="users-mobile-cards">
            {users.map((user) => {
              const isSelf = user.id === currentUserId
              return (
                <div
                  key={user.id}
                  data-slot="user-card"
                  data-user-id={user.id}
                  className="rounded-lg border border-border bg-card p-3.5 shadow-xs flex flex-col gap-2.5"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <UserAvatar
                      name={user.display_name || user.username}
                      src={user.avatar_url}
                      size="md"
                    />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="font-medium text-foreground text-sm truncate">
                        {user.username}
                      </span>
                      {user.display_name && (
                        <span className="text-xs text-muted-foreground truncate">
                          {user.display_name}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <UserBadges user={user} isSelf={isSelf} placement="mobile" />
                  </div>

                  <div className="text-xs text-muted-foreground truncate">{user.email || '—'}</div>

                  <div className="flex flex-wrap items-center gap-1.5 pt-1.5 border-t border-border/60">
                    <UserPrimaryActions
                      user={user}
                      isOwner={isOwner}
                      layout="mobile"
                      onEdit={() => handleEdit(user)}
                      onAssign={() => setAssignUser(user)}
                    />
                    <div className="ml-auto">
                      <UserMoreActionsMenu
                        user={user}
                        isOwner={isOwner}
                        isSelf={isSelf}
                        onResetTotp={handleResetTotp}
                        onResetPassword={setResetPasswordUser}
                        onUnlinkSso={handleOpenUnlink}
                        triggerClassName="min-h-11 min-w-11 p-0 text-muted-foreground hover:text-foreground"
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <div
            data-slot="users-table-wrapper"
            className="hidden md:block rounded-lg border border-border bg-card shadow-xs overflow-x-auto"
          >
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>User</TableHead>
                  <TableHead className="hidden lg:table-cell">Role</TableHead>
                  <TableHead className="hidden lg:table-cell">Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Two-factor</TableHead>
                  <TableHead className="hidden lg:table-cell">Email</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => {
                  const isSelf = user.id === currentUserId
                  return (
                    <TableRow key={user.id} data-slot="user-row" data-user-id={user.id}>
                      <TableCell>
                        <div className="flex items-start gap-2 min-w-0">
                          <UserAvatar
                            name={user.display_name || user.username}
                            src={user.avatar_url}
                            size="md"
                          />
                          <div className="flex flex-col min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-medium text-foreground text-sm">
                                {user.username}
                              </span>
                              <UserBadges user={user} isSelf={isSelf} placement="table" />
                            </div>
                            {user.display_name && (
                              <span className="text-xs text-muted-foreground truncate">
                                {user.display_name}
                              </span>
                            )}
                            <div className="flex flex-wrap items-center gap-1 mt-1.5 lg:hidden">
                              <UserBadges user={user} isSelf={isSelf} placement="compact" />
                            </div>
                          </div>
                        </div>
                      </TableCell>

                      <TableCell className="hidden lg:table-cell">
                        <Badge variant="secondary" className="text-xs capitalize font-medium">
                          {user.role}
                        </Badge>
                      </TableCell>

                      <TableCell className="hidden lg:table-cell">
                        <Badge
                          variant={user.status === 'active' ? 'online' : 'alert'}
                          className="text-xs capitalize"
                        >
                          {user.status}
                        </Badge>
                      </TableCell>

                      <TableCell className="hidden lg:table-cell">
                        <span className="text-xs text-muted-foreground">
                          {user.totp_required ? 'Required' : 'Optional'}
                        </span>
                      </TableCell>

                      <TableCell className="hidden lg:table-cell">
                        <span className="text-xs text-muted-foreground">{user.email || '—'}</span>
                      </TableCell>

                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <UserPrimaryActions
                            user={user}
                            isOwner={isOwner}
                            layout="table"
                            onEdit={() => handleEdit(user)}
                            onAssign={() => setAssignUser(user)}
                          />
                          <UserMoreActionsMenu
                            user={user}
                            isOwner={isOwner}
                            isSelf={isSelf}
                            onResetTotp={handleResetTotp}
                            onResetPassword={setResetPasswordUser}
                            onUnlinkSso={handleOpenUnlink}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {/* Dialogs */}
      <UserCreateDialog open={createOpen} onOpenChange={setCreateOpen} />

      <UserEditDialog
        user={editingUser}
        currentUserId={currentUserId}
        open={editOpen}
        onOpenChange={setEditOpen}
      />

      {isOwner && (
        <AssignDevicesDialog
          user={assignUser}
          open={assignUser !== null}
          onOpenChange={(open) => {
            if (!open) setAssignUser(null)
          }}
        />
      )}

      <UserResetTotpDialog
        user={resetTotpUser}
        currentUserId={currentUserId}
        open={resetTotpOpen}
        onOpenChange={setResetTotpOpen}
      />
      {isOwner && (
        <UserResetPasswordDialog
          user={resetPasswordUser}
          open={resetPasswordUser !== null}
          onOpenChange={(open) => {
            if (!open) setResetPasswordUser(null)
          }}
        />
      )}
      <Dialog
        open={!!unlinkUser}
        onOpenChange={(open) => {
          if (!open) setUnlinkUser(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Unlink SSO</DialogTitle>
            <DialogDescription>
              {unlinkUser?.display_name || unlinkUser?.username} will no longer sign in through the
              provider and will be signed out.
            </DialogDescription>
          </DialogHeader>
          {unlinkError && (
            <p role="alert" className="text-xs text-destructive">
              {unlinkError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnlinkUser(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={unlink.isPending}
              onClick={() => {
                if (unlinkUser) unlink.mutate(unlinkUser)
              }}
            >
              {unlink.isPending ? 'Unlinking…' : 'Unlink SSO'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
