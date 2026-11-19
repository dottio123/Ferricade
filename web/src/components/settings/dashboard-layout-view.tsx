import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/toast'
import { applyPreset, type PresetId } from '@/features/dashboard/preferences'
import { useDashboardPreferences, useUpdatePreferences } from '@/features/dashboard/use-preferences'
import { AccountNavTabs } from '@/components/account/account-nav-tabs'
import { PageHeader } from '@/components/page-header'
import { CheckIcon } from 'lucide-react'

export function DashboardLayoutView() {
  const { catalog, preferences } = useDashboardPreferences()
  const updatePreferences = useUpdatePreferences()
  const { toast } = useToast()

  const currentPreset: PresetId = preferences?.preset ?? 'business'

  const presets: { id: 'homelab' | 'business' | 'wall'; name: string; desc: string }[] = [
    {
      id: 'homelab',
      name: 'Homelab',
      desc: 'Compact layout focused on quick connects, live sessions, and the approval queue.',
    },
    {
      id: 'business',
      name: 'Business',
      desc: 'Full fleet overview with platform distribution, session analytics, and recent activity.',
    },
    {
      id: 'wall',
      name: 'Wall display',
      desc: 'High-density operations view optimized for wall monitors and NOC screens.',
    },
  ]

  const handleApply = (presetId: 'homelab' | 'business' | 'wall') => {
    if (!catalog || !preferences) return
    const next = applyPreset(catalog, preferences, presetId)
    updatePreferences.mutate(next, {
      onSuccess: () => {
        toast({ title: `Applied ${presetId} preset` })
      },
    })
  }

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <PageHeader
        title="Dashboard Layout"
        description="Reset your command center modules and arrangement to a standard preset."
      />

      <AccountNavTabs active="dashboard" />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Layout presets</CardTitle>
          <CardDescription className="text-xs">
            Reset your command center modules and arrangement to a standard preset.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {presets.map((preset) => {
              const isActive = currentPreset === preset.id
              return (
                <div
                  key={preset.id}
                  className={`flex flex-col justify-between rounded-lg border p-4 transition-colors ${
                    isActive
                      ? 'border-primary/60 bg-primary/5'
                      : 'border-border bg-card hover:bg-muted/30'
                  }`}
                >
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-foreground">{preset.name}</span>
                      {isActive && (
                        <Badge
                          variant="outline"
                          className="text-2xs gap-1 text-primary border-primary/30"
                        >
                          <CheckIcon className="size-3" />
                          Active
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{preset.desc}</p>
                  </div>

                  <div className="pt-4">
                    <Button
                      type="button"
                      variant={isActive ? 'secondary' : 'outline'}
                      size="sm"
                      className="w-full text-xs"
                      onClick={() => handleApply(preset.id)}
                      disabled={updatePreferences.isPending}
                    >
                      Apply {preset.name}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
