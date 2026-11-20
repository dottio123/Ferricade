import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import { useToast } from '../components/ui/toast'
import {
  ActivityIcon,
  ChevronsUpDownIcon,
  FolderTreeIcon,
  InfoIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MenuIcon,
  MonitorIcon,
  PinIcon,
  PaletteIcon,
  ScrollTextIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  TagsIcon,
  UserIcon,
} from 'lucide-react'
import { requireSignedIn } from '../auth/guard'
import { mainNavPaths, redirectForRole, useRole } from '../auth/role'
import { getAuthErrorMessage } from '../auth/messages'
import { useMe } from '../auth/session'
import { useSignOut } from '../auth/signIn'
import { useCssHeightVar } from '../hooks/useCssHeightVar'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { getPlatformKeyHint } from '../lib/platform'
import { summaryQueryOptions } from '../lib/queries'
import { useSharedTicker } from '../lib/ticker'
import { cn } from '../lib/utils'
import { useLiveEvents, useLiveStatus } from '../live/useLiveEvents'
import {
  connectionLabel,
  LiveIndicator,
  useServerHealth,
} from '../components/server/live-indicator'
import { PlainHttpIndicator } from '../components/server/plain-http-indicator'
import { DevicePanel } from '../components/devices/device-panel'
import { GlobalGroupConflictDialog } from '../components/devices/group-conflict-dialog'
import { CommandPalette } from '../components/palette/command-palette'
import { useThemeSwitch } from '../features/appearance/use-theme-switch'
import { useRawPreferences } from '../features/dashboard/use-preferences'
import { UserAvatar } from '../components/user-avatar'
import { AboutDialog } from '../components/about/about-dialog'
import { FMark } from '../components/brand/f-mark'
import { Wordmark } from '../components/brand/wordmark'
import { clearIntroFlag, readIntroFlag } from '../auth/intro-flag'
import { FerricadeIntro } from '../components/motion/ferricade-intro'

// ?device=<id> on any signed-in page opens the device panel over it
// (DevicePanel below; DeviceLink sets it). Every page inherits it;
// ?from=<id> records the origin device when opened from an allowed-ID chip inside a panel.
function validateShellSearch(search: Record<string, unknown>): {
  device?: string
  from?: string
} {
  const out: { device?: string; from?: string } = {}
  if (typeof search.device === 'string' && search.device) {
    out.device = search.device
  }
  if (typeof search.from === 'string' && search.from && out.device && search.from !== out.device) {
    out.from = search.from
  }
  return out
}

export const Route = createFileRoute('/_app')({
  validateSearch: validateShellSearch,
  beforeLoad: async ({ context, location }) => {
    const me = await requireSignedIn(context.queryClient, location)
    // A User's routes without anything behind them go to / before they render.
    if (redirectForRole(me.user.role, location.pathname)) {
      throw redirect({ to: '/', replace: true })
    }
    return { me }
  },
  component: AppShell,
})

function useTimeOfDay() {
  const now = useSharedTicker(10_000)
  return new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

interface ProfileMenuProps {
  collapsed?: boolean
  me: ReturnType<typeof useMe>['data']
  currentTheme: 'light' | 'dark' | 'system'
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  signOut: ReturnType<typeof useSignOut>
  onItemClick?: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  tooltipOpen?: boolean
  onTooltipOpenChange?: (open: boolean) => void
  onCloseAutoFocus?: (event: Event) => void
}

function ProfileMenu({
  collapsed,
  me,
  currentTheme,
  setTheme,
  signOut,
  onItemClick,
  open,
  onOpenChange,
  tooltipOpen,
  onTooltipOpenChange,
  onCloseAutoFocus,
}: ProfileMenuProps) {
  const displayName = me?.user.display_name || me?.user.username || 'User'
  const role = me?.user.role || 'admin'

  const buttonContent = (
    <Button
      type="button"
      variant="ghost"
      aria-label={`Profile: ${displayName}`}
      data-sidebar-focus="profile"
      className={cn(
        'flex items-center rounded-md transition-colors hover:bg-muted text-foreground focus-visible:ring-2 focus-visible:ring-ring select-none w-full justify-between px-3 py-1.5 h-auto text-left short:py-1 overflow-hidden',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <UserAvatar name={displayName} src={me?.user.avatar_url} size="sm" />
        <div
          aria-hidden={collapsed || undefined}
          className={cn(
            'flex flex-col min-w-0 truncate sidebar-label',
            collapsed && 'sidebar-label-collapsed',
          )}
        >
          <span className="text-xs font-medium text-foreground truncate leading-tight">
            {displayName}
          </span>
          <span className="text-2xs uppercase font-semibold text-muted-foreground truncate leading-tight">
            {role}
          </span>
        </div>
      </div>
      <ChevronsUpDownIcon
        aria-hidden="true"
        className={cn(
          'size-3.5 text-muted-foreground shrink-0 sidebar-label',
          collapsed && 'sidebar-label-collapsed',
        )}
      />
    </Button>
  )

  const trigger =
    onTooltipOpenChange !== undefined ? (
      <Tooltip open={Boolean(collapsed && tooltipOpen)} onOpenChange={onTooltipOpenChange}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{buttonContent}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">Profile: {displayName}</TooltipContent>
      </Tooltip>
    ) : (
      <DropdownMenuTrigger asChild>{buttonContent}</DropdownMenuTrigger>
    )

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {trigger}
      <DropdownMenuContent
        side="top"
        align={collapsed ? 'center' : 'start'}
        onCloseAutoFocus={onCloseAutoFocus}
        className="w-56"
      >
        <DropdownMenuItem asChild onClick={onItemClick}>
          <Link to="/account" className="flex items-center gap-2 cursor-pointer w-full">
            <UserIcon className="size-4 text-muted-foreground" />
            <span>User settings</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="flex items-center gap-2 cursor-pointer">
            <PaletteIcon className="size-4 text-muted-foreground" />
            <span>Appearance</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-36">
            <DropdownMenuRadioGroup
              value={currentTheme}
              onValueChange={(val) => setTheme(val as 'light' | 'dark' | 'system')}
            >
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            onItemClick?.()
            signOut.mutate()
          }}
          disabled={signOut.isPending}
          variant="destructive"
          className="cursor-pointer"
        >
          <LogOutIcon className="size-4" />
          <span>{signOut.isPending ? 'Signing out…' : 'Sign out'}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AppShell() {
  const headerRef = React.useRef<HTMLElement>(null)
  useLiveEvents()
  const live = useLiveStatus()
  const serverHealth = useServerHealth()
  const me = useMe().data
  const role = useRole()
  const isUser = role === 'user'
  // A User has no approval queue (no pending devices, no badge).
  const pending = useQuery({ ...summaryQueryOptions, enabled: !isUser }).data?.devices.pending
  const signOut = useSignOut()
  const navigate = useNavigate()
  const location = useLocation()
  const isRootPath = location.pathname === '/'
  const search = useSearch({ strict: false }) as {
    kiosk?: boolean
    device?: string
  }
  const { data: rawPrefs } = useRawPreferences()
  // The wall display is not offered to a User: ?kiosk=1 is ignored.
  const isKioskMode = Boolean(
    isRootPath && search.kiosk && rawPrefs?.preset === 'wall' && role !== 'user',
  )
  useCssHeightVar(headerRef, '--app-header-h', !isKioskMode)
  const timeOfDay = useTimeOfDay()

  const { setKioskSuppressed, setDurationSeconds } = useToast()

  React.useEffect(() => {
    setKioskSuppressed(isKioskMode)
    return () => setKioskSuppressed(false)
  }, [isKioskMode, setKioskSuppressed])

  React.useEffect(() => {
    setDurationSeconds(rawPrefs?.toast_seconds ?? 5)
  }, [rawPrefs?.toast_seconds, setDurationSeconds])

  const [pinned, setPinned] = React.useState(() => {
    try {
      return window.localStorage.getItem('ferricade.sidebar.pinned') !== 'false'
    } catch {
      return true
    }
  })
  const [autoExpanded, setAutoExpanded] = React.useState(false)
  const [openSidebarTooltip, setOpenSidebarTooltip] = React.useState<string | null>(null)
  const [profileMenuOpen, setProfileMenuOpen] = React.useState(false)
  const collapsed = !pinned && !autoExpanded
  const sidebarRef = React.useRef<HTMLElement>(null)
  const sidebarTimer = React.useRef<number | undefined>(undefined)
  const pointerResetTimer = React.useRef<number | undefined>(undefined)
  const pointerInsideRef = React.useRef(false)
  const pointerTriggeredRef = React.useRef(false)
  const keyboardFocusRef = React.useRef(false)
  const suppressFocusExpandRef = React.useRef(false)
  const profileMenuOpenRef = React.useRef(false)
  const profileOpenedByKeyboardRef = React.useRef(false)

  const clearSidebarTimer = () => {
    window.clearTimeout(sidebarTimer.current)
  }
  const expandSidebar = () => {
    clearSidebarTimer()
    if (!pinned) {
      setAutoExpanded(true)
    }
  }
  const scheduleSidebarCollapse = () => {
    clearSidebarTimer()
    sidebarTimer.current = window.setTimeout(() => {
      const hasKeyboardFocus =
        keyboardFocusRef.current && Boolean(sidebarRef.current?.contains(document.activeElement))
      if (!pointerInsideRef.current && !hasKeyboardFocus && !profileMenuOpenRef.current) {
        setAutoExpanded(false)
      }
    }, 300)
  }
  const handleProfileMenuOpenChange = (nextOpen: boolean) => {
    profileMenuOpenRef.current = nextOpen
    setProfileMenuOpen(nextOpen)
    if (nextOpen) {
      profileOpenedByKeyboardRef.current = keyboardFocusRef.current || !pointerTriggeredRef.current
      return
    }
    if (!profileOpenedByKeyboardRef.current) {
      suppressFocusExpandRef.current = true
      window.setTimeout(() => {
        suppressFocusExpandRef.current = false
      }, 0)
      if (!pinned && !pointerInsideRef.current) {
        scheduleSidebarCollapse()
      }
    }
  }
  React.useEffect(
    () => () => {
      clearSidebarTimer()
      window.clearTimeout(pointerResetTimer.current)
    },
    [],
  )
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [aboutOpen, setAboutOpen] = React.useState(false)
  const [showIntro, setShowIntro] = React.useState(() => readIntroFlag())

  React.useEffect(() => {
    if (showIntro) clearIntroFlag()
  }, [showIntro])

  const { theme: currentTheme, setTheme } = useThemeSwitch()

  // Global Ctrl+K / ⌘K shortcut listener
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        const isDevicePanelOpen = Boolean(new URLSearchParams(window.location.search).get('device'))
        const otherDialogOpen = Boolean(
          document.querySelector(
            '[role="dialog"]:not([data-slot="command-dialog"]):not([data-state="closed"])',
          ),
        )
        if (isDevicePanelOpen || otherDialogOpen) {
          return
        }
        e.preventDefault()
        setPaletteOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Escape key in kiosk mode exits kiosk when no overlay is open
  React.useEffect(() => {
    if (!isKioskMode) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return
        const isDevicePanelOpen = Boolean(
          new URLSearchParams(window.location.search).get('device') ||
          document.querySelector('[data-slot="sheet-content"]'),
        )
        const otherOverlayOpen = Boolean(
          document.querySelector(
            '[role="dialog"]:not([data-state="closed"]), [role="menu"]:not([data-state="closed"])',
          ),
        )
        if (isDevicePanelOpen || otherOverlayOpen || paletteOpen) {
          return
        }
        e.preventDefault()
        void navigate({
          to: '/',
          search: (prev: Record<string, unknown>) => {
            const next = { ...prev }
            delete next.kiosk
            return next
          },
        })
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isKioskMode, paletteOpen, navigate])

  const allNavItems = [
    { to: '/', label: 'Command Center', icon: LayoutDashboardIcon },
    {
      to: '/devices',
      label: 'Devices',
      icon: MonitorIcon,
      badge: pending && pending > 0 ? `${pending} pending` : undefined,
    },
    { to: '/sessions', label: 'Sessions', icon: ActivityIcon },
    { to: '/audit', label: 'Audit Log', icon: ScrollTextIcon },
    { to: '/groups', label: 'Groups', icon: FolderTreeIcon },
    { to: '/tags', label: 'Tags', icon: TagsIcon },
    { to: '/policies', label: 'Policies', icon: ShieldCheckIcon },
  ]
  const shown = new Set(mainNavPaths(role))
  const navItems = allNavItems.filter((item) => shown.has(item.to))

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {!isKioskMode && (
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-background focus:text-foreground focus:ring-2 focus:ring-ring focus:rounded-md top-2 left-2"
        >
          Skip to content
        </a>
      )}

      {/* Exit kiosk button: first element in tab order in kiosk mode */}
      {isKioskMode && (
        <Button
          type="button"
          data-slot="exit-kiosk-button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigate({
              to: '/',
              search: (prev: Record<string, unknown>) => {
                const next = { ...prev }
                delete next.kiosk
                return next
              },
            })
          }}
          className="fixed top-2 left-2 z-50 opacity-0 hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 transition-opacity bg-card text-foreground border-border shadow-md text-xs pointer-events-auto"
        >
          Exit kiosk
        </Button>
      )}

      {/* Fixed connection indicator for kiosk mode */}
      {isKioskMode && (
        <div
          role="status"
          aria-live="polite"
          data-slot="kiosk-status"
          className={cn(
            'fixed bottom-3 right-3 z-40 flex items-center transition-all',
            connectionLabel(live, serverHealth.data?.status) !== 'Live'
              ? 'gap-3 px-4 py-2.5 rounded-lg border-2 border-status-pending bg-status-pending/20 text-status-pending text-base md:text-lg font-bold shadow-lg animate-pulse'
              : 'gap-2 px-2.5 py-1 rounded-md border border-border/80 bg-card/90 backdrop-blur-xs text-xs font-medium text-muted-foreground shadow-xs',
          )}
        >
          <span
            className={cn(
              'rounded-full shrink-0',
              connectionLabel(live, serverHealth.data?.status) !== 'Live'
                ? 'size-3 bg-status-pending animate-status-pulse'
                : 'size-2 bg-status-live',
            )}
            aria-hidden="true"
          />
          <span>
            {connectionLabel(live, serverHealth.data?.status)} · {timeOfDay}
          </span>
        </div>
      )}

      {/* Sidebar (desktop only, hidden in kiosk mode) */}
      {!isKioskMode && (
        <aside
          ref={sidebarRef}
          onPointerEnter={() => {
            pointerInsideRef.current = true
            clearSidebarTimer()
            if (!pinned && !autoExpanded) {
              sidebarTimer.current = window.setTimeout(() => setAutoExpanded(true), 150)
            }
          }}
          onPointerLeave={() => {
            pointerInsideRef.current = false
            if (!pinned) scheduleSidebarCollapse()
          }}
          onPointerDownCapture={() => {
            pointerInsideRef.current = true
            pointerTriggeredRef.current = true
            keyboardFocusRef.current = false
            window.clearTimeout(pointerResetTimer.current)
            pointerResetTimer.current = window.setTimeout(() => {
              pointerTriggeredRef.current = false
            }, 300)
          }}
          onKeyDownCapture={(event) => {
            if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
              pointerTriggeredRef.current = false
            }
          }}
          onFocusCapture={() => {
            if (suppressFocusExpandRef.current) {
              suppressFocusExpandRef.current = false
              return
            }
            if (pointerTriggeredRef.current) return
            keyboardFocusRef.current = true
            expandSidebar()
          }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              keyboardFocusRef.current = false
              if (!pinned) scheduleSidebarCollapse()
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || pinned || !autoExpanded) return
            event.preventDefault()
            const target = event.target as HTMLElement
            const focusKey = target.dataset.sidebarFocus
            clearSidebarTimer()
            keyboardFocusRef.current = false
            setAutoExpanded(false)
            if (focusKey)
              requestAnimationFrame(() => {
                const el =
                  sidebarRef.current?.querySelector<HTMLElement>(
                    `[data-sidebar-focus="${focusKey}"]`,
                  ) ?? sidebarRef.current?.querySelector<HTMLElement>('nav a')
                if (el) {
                  suppressFocusExpandRef.current = true
                  el.focus()
                  window.setTimeout(() => {
                    suppressFocusExpandRef.current = false
                  }, 0)
                }
              })
          }}
          className={cn(
            'relative hidden md:flex flex-col shrink-0 select-none sticky top-0 h-dvh self-start z-40 sidebar-aside',
            pinned ? 'w-60' : 'w-16',
          )}
        >
          <div
            data-slot="sidebar-panel"
            data-sidebar-state={collapsed ? 'collapsed' : pinned ? 'pinned' : 'expanded'}
            className={cn(
              'absolute inset-y-0 left-0 flex flex-col justify-between border-r border-border bg-chrome text-chrome-foreground overflow-hidden sidebar-panel',
              collapsed ? 'w-16 shadow-none' : 'w-60',
              !pinned && !collapsed && 'shadow-xl',
            )}
          >
            <div className="flex flex-col flex-1 min-h-0">
              <div
                data-slot="sidebar-header"
                className={cn(
                  'flex h-[var(--app-header-h,3.5rem)] shrink-0 items-center border-b border-border px-3 overflow-hidden',
                  collapsed ? 'justify-center' : 'justify-between',
                )}
              >
                {collapsed ? (
                  <FMark variant="flat" className="h-6 w-auto sidebar-mark-enter" />
                ) : (
                  <>
                    <Wordmark variant="flat" className="h-6 w-auto pl-1 sidebar-reveal" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            const nextPinned = !pinned
                            setPinned(nextPinned)
                            setAutoExpanded(!nextPinned)
                            try {
                              window.localStorage.setItem(
                                'ferricade.sidebar.pinned',
                                String(nextPinned),
                              )
                            } catch {
                              // Storage is optional; the in-memory setting still works.
                            }
                          }}
                          aria-pressed={pinned}
                          aria-label={pinned ? 'Unpin sidebar' : 'Pin sidebar'}
                          data-sidebar-focus="pin"
                          className="h-8 w-8 p-0 text-muted-foreground shrink-0 sidebar-reveal"
                        >
                          <PinIcon className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        {pinned ? 'Unpin sidebar' : 'Pin sidebar'}
                      </TooltipContent>
                    </Tooltip>
                  </>
                )}
              </div>

              <nav
                aria-label="Main"
                className="flex-1 p-2 short:p-1.5 overflow-y-auto overflow-x-hidden"
              >
                <ul className="flex flex-col gap-1 short:gap-0.5">
                  {navItems.map((item) => {
                    const Icon = item.icon
                    const content = (
                      <Link
                        to={item.to}
                        data-sidebar-focus={item.to}
                        aria-label={
                          collapsed
                            ? item.badge
                              ? `${item.label}, ${item.badge}`
                              : item.label
                            : undefined
                        }
                        activeProps={{
                          className: 'bg-nav-active text-nav-active-foreground font-medium',
                        }}
                        inactiveProps={{
                          className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        }}
                        className="flex items-center gap-3 rounded-md px-4 py-2 short:py-1 text-xs transition-colors overflow-hidden whitespace-nowrap"
                      >
                        <Icon className="size-4 shrink-0" />
                        <span
                          aria-hidden={collapsed || undefined}
                          className={cn(
                            'flex flex-1 items-center gap-2 min-w-0 sidebar-label',
                            collapsed && 'sidebar-label-collapsed',
                          )}
                        >
                          <span className="flex-1 truncate">{item.label}</span>
                          {item.badge && (
                            <Badge variant="pending" className="px-1.5 py-0 text-2xs shrink-0">
                              {item.badge}
                            </Badge>
                          )}
                        </span>
                      </Link>
                    )

                    return (
                      <li key={item.to}>
                        <Tooltip
                          open={collapsed && openSidebarTooltip === item.to}
                          onOpenChange={(open) => setOpenSidebarTooltip(open ? item.to : null)}
                        >
                          <TooltipTrigger asChild>{content}</TooltipTrigger>
                          <TooltipContent side="right">
                            <span>{item.label}</span>
                            {item.badge && (
                              <span className="ml-1 text-status-pending">({item.badge})</span>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </li>
                    )
                  })}
                </ul>
              </nav>
            </div>

            {/* Bottom pinned items: About, System Settings & Profile */}
            <div className="border-t border-border p-2 short:p-1.5 flex flex-col gap-1 short:gap-0.5 shrink-0">
              <Tooltip
                open={collapsed && openSidebarTooltip === 'about'}
                onOpenChange={(open) => setOpenSidebarTooltip(open ? 'about' : null)}
              >
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={collapsed ? 'About' : undefined}
                    data-sidebar-focus="about"
                    onClick={() => setAboutOpen(true)}
                    className="flex items-center gap-3 rounded-md px-4 py-2 short:py-1 text-left text-xs transition-colors text-muted-foreground hover:bg-muted hover:text-foreground overflow-hidden whitespace-nowrap"
                  >
                    <InfoIcon className="size-4 shrink-0" />
                    <span
                      aria-hidden={collapsed || undefined}
                      className={cn(
                        'flex-1 truncate sidebar-label',
                        collapsed && 'sidebar-label-collapsed',
                      )}
                    >
                      About
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">About</TooltipContent>
              </Tooltip>

              {!isUser && (
                <Tooltip
                  open={collapsed && openSidebarTooltip === 'settings'}
                  onOpenChange={(open) => setOpenSidebarTooltip(open ? 'settings' : null)}
                >
                  <TooltipTrigger asChild>
                    <Link
                      to="/settings"
                      aria-label={collapsed ? 'System Settings' : undefined}
                      data-sidebar-focus="settings"
                      activeProps={{
                        className: 'bg-nav-active text-nav-active-foreground font-medium',
                      }}
                      inactiveProps={{
                        className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      }}
                      className="flex items-center gap-3 rounded-md px-4 py-2 short:py-1 text-xs transition-colors overflow-hidden whitespace-nowrap"
                    >
                      <SettingsIcon className="size-4 shrink-0" />
                      <span
                        aria-hidden={collapsed || undefined}
                        className={cn(
                          'flex-1 truncate sidebar-label',
                          collapsed && 'sidebar-label-collapsed',
                        )}
                      >
                        System Settings
                      </span>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right">System Settings</TooltipContent>
                </Tooltip>
              )}

              <ProfileMenu
                collapsed={collapsed}
                me={me}
                currentTheme={currentTheme}
                setTheme={setTheme}
                signOut={signOut}
                open={profileMenuOpen}
                onOpenChange={handleProfileMenuOpenChange}
                tooltipOpen={openSidebarTooltip === 'profile'}
                onTooltipOpenChange={(open) => setOpenSidebarTooltip(open ? 'profile' : null)}
                onCloseAutoFocus={(event) => {
                  if (!profileOpenedByKeyboardRef.current && !pointerInsideRef.current) {
                    event.preventDefault()
                  }
                }}
              />

              {signOut.error && (
                <span role="alert" className="text-2xs text-destructive px-2 pt-1">
                  {getAuthErrorMessage(signOut.error)}
                </span>
              )}
            </div>
          </div>
        </aside>
      )}

      {/* Main Container */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Top bar (hidden in kiosk mode) */}
        {!isKioskMode && (
          <header
            ref={headerRef}
            className="sticky top-0 z-30 flex min-h-14 h-auto flex-wrap items-center justify-between border-b border-border bg-chrome/80 text-chrome-foreground px-3 sm:px-4 py-2 backdrop-blur-xs gap-2 sm:gap-4"
          >
            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              {/* Mobile menu trigger */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open navigation menu"
                className="md:hidden h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              >
                <MenuIcon className="size-4" />
              </Button>

              {/* Search trigger */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPaletteOpen(true)}
                data-slot="search-trigger"
                aria-label={`Search (${getPlatformKeyHint()})`}
                className="w-32 sm:w-48 justify-between text-muted-foreground bg-surface-1 hover:text-foreground cursor-pointer"
              >
                <span className="flex items-center gap-1.5 text-xs truncate">
                  <SearchIcon className="size-3.5 shrink-0" />
                  <span className="truncate">Search</span>
                </span>
                <kbd className="hidden sm:inline-block pointer-events-none rounded border border-border bg-muted px-1 text-xs font-mono">
                  {getPlatformKeyHint()}
                </kbd>
              </Button>
            </div>

            <div className="flex items-center flex-wrap justify-end gap-3 sm:gap-4 min-w-0">
              <PlainHttpIndicator />
              <LiveIndicator />
            </div>
          </header>
        )}

        {/* Mobile Navigation Sheet (hidden in kiosk mode) */}
        {!isKioskMode && (
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetContent
              side="left"
              className="w-72 p-0 flex flex-col justify-between"
              onOpenAutoFocus={(event) => {
                const currentLink =
                  document.querySelector<HTMLElement>(
                    'nav[aria-label="Mobile navigation"] a[aria-current="page"]',
                  ) ?? document.querySelector<HTMLElement>('nav[aria-label="Mobile navigation"] a')
                if (currentLink) {
                  event.preventDefault()
                  currentLink.focus()
                }
              }}
            >
              <div className="flex flex-col flex-1 min-h-0">
                <SheetHeader className="h-14 flex flex-row items-center justify-between border-b border-border px-4 py-0 space-y-0">
                  <SheetTitle className="flex items-center">
                    <Wordmark variant="flat" className="h-6 w-auto" />
                  </SheetTitle>
                </SheetHeader>

                <nav aria-label="Mobile navigation" className="p-3 overflow-y-auto flex-1">
                  <ul className="flex flex-col gap-1">
                    {navItems.map((item) => {
                      const Icon = item.icon
                      return (
                        <li key={item.to}>
                          <Link
                            to={item.to}
                            onClick={() => setMobileNavOpen(false)}
                            activeProps={{
                              className: 'bg-nav-active text-nav-active-foreground font-medium',
                            }}
                            inactiveProps={{
                              className:
                                'text-muted-foreground hover:bg-muted hover:text-foreground',
                            }}
                            className="flex items-center gap-3 rounded-md px-3 py-2.5 text-xs transition-colors"
                          >
                            <Icon className="size-4 shrink-0" />
                            <span className="flex-1 truncate">{item.label}</span>
                            {item.badge && (
                              <Badge variant="pending" className="px-1.5 py-0 text-2xs">
                                {item.badge}
                              </Badge>
                            )}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                </nav>
              </div>

              {/* Mobile Sheet Footer */}
              <div className="border-t border-border p-3 flex flex-col gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setMobileNavOpen(false)
                    setAboutOpen(true)
                  }}
                  className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left text-xs transition-colors text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <InfoIcon className="size-4 shrink-0" />
                  <span className="flex-1 truncate">About</span>
                </button>
                {!isUser && (
                  <Link
                    to="/settings"
                    onClick={() => setMobileNavOpen(false)}
                    activeProps={{
                      className: 'bg-nav-active text-nav-active-foreground font-medium',
                    }}
                    inactiveProps={{
                      className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    }}
                    className="flex items-center gap-3 rounded-md px-3 py-2.5 text-xs transition-colors"
                  >
                    <SettingsIcon className="size-4 shrink-0" />
                    <span className="flex-1 truncate">System Settings</span>
                  </Link>
                )}

                <ProfileMenu
                  collapsed={false}
                  me={me}
                  currentTheme={currentTheme}
                  setTheme={setTheme}
                  signOut={signOut}
                  onItemClick={() => setMobileNavOpen(false)}
                />

                {signOut.error && (
                  <span role="alert" className="text-2xs text-destructive px-2 pt-1">
                    {getAuthErrorMessage(signOut.error)}
                  </span>
                )}
              </div>
            </SheetContent>
          </Sheet>
        )}

        {/* Content Outlet */}
        <main
          id="main-content"
          tabIndex={-1}
          className={cn(
            // clip, not auto: auto would make <main> a scroll container and break sticky bars.
            'flex-1 flex flex-col min-w-0 outline-hidden overflow-x-clip',
            isKioskMode ? 'p-0' : 'p-4 md:p-6',
          )}
        >
          <Outlet />
        </main>
        <DevicePanel />
        <GlobalGroupConflictDialog />
        <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
      {showIntro && <FerricadeIntro onComplete={() => setShowIntro(false)} />}
    </div>
  )
}
