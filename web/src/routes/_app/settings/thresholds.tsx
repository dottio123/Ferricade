import { createFileRoute } from '@tanstack/react-router'
import { ThresholdsView } from '@/components/settings/thresholds-view'

export const Route = createFileRoute('/_app/settings/thresholds')({
  component: ThresholdsView,
})
