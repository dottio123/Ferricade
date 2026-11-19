import { createFileRoute } from '@tanstack/react-router'
import { AccountSettingsView } from '@/components/settings/account-settings-view'

export const Route = createFileRoute('/_app/account/')({
  component: AccountSettingsView,
})
