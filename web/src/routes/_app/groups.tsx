import { createFileRoute } from '@tanstack/react-router'
import { GroupsView } from '@/components/groups/groups-view'

export const Route = createFileRoute('/_app/groups')({
  component: GroupsView,
})
