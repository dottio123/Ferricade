import type { DashboardModuleId } from './preferences'

export const moduleTitles = {
  'fleet-pulse': 'Fleet pulse',
  'quick-connect': 'Quick connect',
  'approval-queue': 'Approval queue',
  'needs-attention': 'Needs attention',
  'live-sessions': 'Live sessions',
  'activity-trend': 'Activity trend',
  'fleet-overview': 'Fleet overview',
  'recent-sessions': 'Recent sessions',
  'session-analytics': 'Session analytics',
  'platform-mix': 'Platform mix',
  'admin-activity': 'Admin activity',
} satisfies Record<DashboardModuleId, string>
