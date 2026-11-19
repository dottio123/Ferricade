import { createFileRoute } from '@tanstack/react-router'
import { CommandCenter } from '@/features/dashboard/command-center'

export const Route = createFileRoute('/_app/')({
  validateSearch: (search: Record<string, unknown>): { kiosk?: boolean } => {
    const raw = search.kiosk
    const isKiosk = raw === 1 || raw === '1' || raw === true || raw === 'true'
    return isKiosk ? { kiosk: true } : {}
  },
  component: CommandCenter,
})
