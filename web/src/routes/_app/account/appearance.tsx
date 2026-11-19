import { createFileRoute } from '@tanstack/react-router'
import { AppearanceSettingsView } from '@/components/settings/appearance-settings-view'

export const Route = createFileRoute('/_app/account/appearance')({
  component: AppearanceSettingsView,
})
