import { createFileRoute } from '@tanstack/react-router'
import { LogExportView } from '@/components/settings/log-export-view'

export const Route = createFileRoute('/_app/settings/log-export')({
  component: LogExportView,
})
