import { Link } from '@tanstack/react-router'
import { cn } from '@/lib/utils'

interface AccountNavTabsProps {
  active: 'account' | 'appearance' | 'dashboard'
}

export function AccountNavTabs({ active }: AccountNavTabsProps) {
  const tabs = [
    { id: 'account', label: 'Account', to: '/account' as const },
    { id: 'appearance', label: 'Appearance', to: '/account/appearance' as const },
    { id: 'dashboard', label: 'Dashboard Layout', to: '/account/dashboard' as const },
  ]

  return (
    <nav aria-label="User settings tabs" className="flex border-b border-border gap-2 pb-2 mb-6">
      {tabs.map((tab) => {
        const isActive = active === tab.id
        return (
          <Link
            key={tab.id}
            to={tab.to}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring select-none',
              isActive
                ? 'bg-nav-active text-nav-active-foreground font-medium'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
