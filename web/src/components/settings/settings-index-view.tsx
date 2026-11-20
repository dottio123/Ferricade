import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api, unwrap } from '@/api/client'
import { useMe } from '@/auth/session'
import { ClientConfig } from '@/components/client-config'
import { ErrorState } from '@/components/brand/error-state'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'
import { queryKeys } from '@/lib/queryKeys'
import {
  ChevronRightIcon,
  FileTextIcon,
  KeyRoundIcon,
  LaptopIcon,
  ListFilterIcon,
  PackageIcon,
  ServerIcon,
  SlidersIcon,
  UsersIcon,
} from 'lucide-react'

type NavCard =
  | {
      to:
        | '/settings/server'
        | '/settings/thresholds'
        | '/settings/users'
        | '/settings/sign-in'
        | '/settings/deployment'
        | '/settings/log-export'
        | '/settings/id-allow-list'
      href?: never
      title: string
      description: string
      icon: typeof ServerIcon
    }
  | {
      to?: never
      href: string
      title: string
      description: string
      icon: typeof ServerIcon
    }

export function SettingsIndexView() {
  const { data: me } = useMe()
  const isOwner = me?.user.role === 'owner'
  const isStaff = isOwner || me?.user.role === 'admin'

  const {
    data: config,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.clientConfig(),
    queryFn: () => unwrap(api.GET('/admin/api/v1/server/client-config')),
  })

  const navCards: NavCard[] = [
    {
      to: '/settings/server',
      title: 'Server',
      description: 'Profile name, ID & relay hosts, public key, and reachability tests.',
      icon: ServerIcon,
    },
    {
      to: '/settings/thresholds',
      title: 'Fleet Thresholds',
      description: 'Device attention thresholds for offline durations and pending approvals.',
      icon: SlidersIcon,
    },
    {
      to: '/settings/deployment',
      title: 'Deployment',
      description: 'Prepare unattended deployment scripts and configure client install profiles.',
      icon: PackageIcon,
    },
    {
      to: '/settings/log-export',
      title: 'Log Export',
      description: 'Send the audit trail and remote sessions to a log file or a syslog collector.',
      icon: FileTextIcon,
    },
    ...(isStaff
      ? [
          {
            to: '/settings/id-allow-list' as const,
            title: 'Global ID Allowlist',
            description: 'Limit which RustDesk IDs can connect to managed devices.',
            icon: ListFilterIcon,
          },
        ]
      : []),
    ...(isOwner
      ? [
          {
            to: '/settings/users' as const,
            title: 'Users',
            description: 'Manage console user accounts, passwords, roles, and MFA resets.',
            icon: UsersIcon,
          },
          {
            to: '/settings/sign-in' as const,
            title: 'Sign-In',
            description: 'Configure provider access, account linking, and role groups.',
            icon: KeyRoundIcon,
          },
        ]
      : []),
    {
      href: '#client-setup',
      title: 'Client Setup',
      description: 'Download configuration, command-line arguments, and host setup strings.',
      icon: LaptopIcon,
    },
  ]

  return (
    <div className="flex flex-col gap-8 w-full max-w-3xl mx-auto">
      <PageHeader
        title="Settings"
        description="Manage system configurations, server reachability, and fleet thresholds."
      />

      {/* Navigation cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {navCards.map((card) => {
          const Icon = card.icon
          const cardContent = (
            <Card className="h-full transition-colors hover:border-primary/50 hover:bg-muted/30">
              <CardHeader className="p-4 flex flex-col justify-between h-full">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex size-8 items-center justify-center rounded-md bg-muted text-foreground group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                      <Icon className="size-4" />
                    </div>
                    <ChevronRightIcon className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-semibold">{card.title}</CardTitle>
                    <CardDescription className="text-xs mt-1 leading-relaxed">
                      {card.description}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          )

          if ('href' in card && card.href) {
            return (
              <a
                key={card.title}
                href={card.href}
                className="group block focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
              >
                {cardContent}
              </a>
            )
          }

          if (card.to) {
            return (
              <Link
                key={card.title}
                to={card.to}
                className="group block focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
              >
                {cardContent}
              </Link>
            )
          }

          return null
        })}
      </div>

      {/* Client Configuration Section */}
      <div id="client-setup" className="flex flex-col gap-4 border-t border-border pt-6">
        <div>
          <h2 className="text-base font-semibold text-foreground">Client Configuration</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Share this configuration with users or import it directly into RustDesk clients.
          </p>
        </div>

        {isLoading ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : error ? (
          <ErrorState
            title="Failed to load client configuration"
            error={error}
            retry={() => void refetch()}
          />
        ) : config ? (
          <div className="rounded-lg border border-border bg-card p-5">
            <ClientConfig config={config} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
