import { createFileRoute } from '@tanstack/react-router'
import { DashboardLayoutView } from '@/components/settings/dashboard-layout-view'

export const Route = createFileRoute('/_app/account/dashboard')({
  component: DashboardLayoutView,
})
