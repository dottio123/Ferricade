import { createFileRoute } from '@tanstack/react-router'
import { SettingsIndexView } from '@/components/settings/settings-index-view'

export const Route = createFileRoute('/_app/settings/')({
  component: SettingsIndexView,
})
