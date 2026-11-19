import { useQuery } from '@tanstack/react-query'
import { MonitorIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { summaryQueryOptions } from '@/lib/queries'
import type { DashboardModuleSize } from '../preferences'
import { ModuleCard, ModuleEmptyState, ModuleErrorState } from './module-card'

export function PlatformMixModule({ size = 'medium' }: { size?: DashboardModuleSize }) {
  const summaryQuery = useQuery(summaryQueryOptions)

  const summary = summaryQuery.data
  const osList = summary?.os ?? []
  const versionList = summary?.versions ?? []
  const totalApproved = summary?.devices.approved ?? 0

  const maxOs = size === 'small' ? 3 : 5
  const maxVersions = size === 'small' ? 2 : 5
  const remainingOs = osList.slice(maxOs)
  const remainingCount = remainingOs.reduce((total, os) => total + os.count, 0)

  return (
    <ModuleCard title="Platform mix" icon={<MonitorIcon className="size-4" />}>
      {summaryQuery.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : summaryQuery.isLoadingError ? (
        <ModuleErrorState error={summaryQuery.error} retry={() => void summaryQuery.refetch()} />
      ) : osList.length === 0 && versionList.length === 0 ? (
        <ModuleEmptyState message="No platform data available" />
      ) : (
        <div className="flex flex-col gap-2">
          {/* Operating Systems */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Operating systems
            </span>
            <div className="flex flex-col gap-0">
              {osList.slice(0, maxOs).map((os) => {
                const pct = totalApproved > 0 ? Math.round((os.count / totalApproved) * 100) : 0

                return (
                  <div key={os.name} className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">{os.name}</span>
                    <div className="flex items-center gap-1.5 tabular-nums text-muted-foreground">
                      <span>{os.count}</span>
                      <span className="text-xs">({pct}%)</span>
                    </div>
                  </div>
                )
              })}
              {remainingOs.length > 0 && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{remainingOs.length} more</span>
                  <div className="flex items-center gap-1.5 tabular-nums">
                    <span>{remainingCount}</span>
                    <span>
                      ({totalApproved > 0 ? Math.round((remainingCount / totalApproved) * 100) : 0}
                      %)
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Client Versions */}
          <div className="flex flex-col gap-1.5 pt-2 border-t border-border/40">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Client versions
            </span>
            <div className="flex flex-col gap-1">
              {versionList.slice(0, maxVersions).map((v) => (
                <div key={v.version} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs text-foreground">{v.version}</span>
                    {v.outdated && (
                      <Badge
                        variant="outline"
                        className="text-2xs px-1 py-0 h-4 bg-status-pending/10 text-status-pending border-status-pending/30"
                      >
                        Outdated
                      </Badge>
                    )}
                  </div>
                  <span className="tabular-nums text-muted-foreground">{v.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </ModuleCard>
  )
}
