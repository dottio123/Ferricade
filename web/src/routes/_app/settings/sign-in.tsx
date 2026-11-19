import { createFileRoute } from '@tanstack/react-router'
import { OwnerOnly } from '@/auth/OwnerOnly'
import { SignInSettingsView } from '@/components/settings/sign-in-settings-view'

export const Route = createFileRoute('/_app/settings/sign-in')({
  component: () => (
    <OwnerOnly action="manage sign-in settings">
      <SignInSettingsView />
    </OwnerOnly>
  ),
})
