import { createFileRoute } from '@tanstack/react-router'
import { DeploymentSettingsView } from '@/components/settings/deployment-view'

export const Route = createFileRoute('/_app/settings/deployment')({
  component: DeploymentSettingsView,
})
