import { createFileRoute } from '@tanstack/react-router'
import { OwnerOnly } from '@/auth/OwnerOnly'
import { UsersView } from '@/components/users/users-view'

export const Route = createFileRoute('/_app/settings/users')({
  component: () => (
    <OwnerOnly action="manage users">
      <UsersView />
    </OwnerOnly>
  ),
})
