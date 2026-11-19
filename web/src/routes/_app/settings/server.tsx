import { createFileRoute } from '@tanstack/react-router'
import { ServerSettingsView } from '@/components/settings/server-settings-view'

export const Route = createFileRoute('/_app/settings/server')({
  component: ServerSettingsView,
})
