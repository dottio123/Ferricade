import { createFileRoute } from '@tanstack/react-router'
import { IdAllowListView } from '@/components/settings/id-allow-list-view'

export const Route = createFileRoute('/_app/settings/id-allow-list')({
  component: IdAllowListView,
})
