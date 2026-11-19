import { createFileRoute } from '@tanstack/react-router'
import { TagsView } from '@/components/tags/tags-view'

export const Route = createFileRoute('/_app/tags')({
  component: TagsView,
})
