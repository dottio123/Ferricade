import * as React from 'react'
import { createFileRoute, notFound } from '@tanstack/react-router'
import {
  applyAppearance,
  readCachedAppearance,
  type Appearance,
  type Density,
  type Theme,
} from '@/lib/appearance'

// UI Components
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from '@/components/ui/toast'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

// Brand Components
import { StatusDot, type DeviceStatus } from '@/components/brand/status-dot'
import { RelativeTime } from '@/components/brand/relative-time'
import { CopyField } from '@/components/brand/copy-field'
import { MonoId } from '@/components/brand/mono-id'
import { EmptyState } from '@/components/brand/empty-state'
import { ErrorState } from '@/components/brand/error-state'

const available = import.meta.env.DEV || import.meta.env.MODE === 'mock'

export const Route = createFileRoute('/dev/kitchen-sink')({
  beforeLoad: () => {
    if (!available) throw notFound()
  },
  component: available ? KitchenSink : () => null,
})

// Sample date constants for pure rendering without calling Date.now()
const SAMPLE_DATE_2M = new Date('2026-10-08T09:40:00Z')
const SAMPLE_DATE_1M = new Date('2026-10-08T09:44:00Z')
const SAMPLE_DATE_1H = new Date('2026-10-08T08:45:00Z')

function KitchenSink() {
  const { toast } = useToast()
  const [appearance, setAppearance] = React.useState<Appearance>(() => readCachedAppearance())
  const [commandOpen, setCommandOpen] = React.useState(false)
  const [dynamicStatus, setDynamicStatus] = React.useState<DeviceStatus>('online')

  const updateTheme = (theme: Theme) => {
    const next = { ...appearance, theme }
    setAppearance(next)
    applyAppearance(next)
  }

  const updateDensity = (density: Density) => {
    const next = { ...appearance, density }
    setAppearance(next)
    applyAppearance(next)
  }

  const cycleStatus = () => {
    const statuses: DeviceStatus[] = ['online', 'pending', 'offline', 'alert', 'live']
    const nextIdx = (statuses.indexOf(dynamicStatus) + 1) % statuses.length
    const nextStatus = statuses[nextIdx]
    if (nextStatus) setDynamicStatus(nextStatus)
  }

  return (
    <main
      data-dev-only="kitchen-sink"
      className="min-h-screen bg-background p-6 md:p-10 space-y-10 max-w-7xl mx-auto"
    >
      {/* Top Header & Appearance Controls */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Kitchen sink</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Component gallery, design tokens, and overlay validation harness.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 bg-muted p-1 rounded-md text-xs font-medium">
            <span className="px-2 text-muted-foreground">Theme:</span>
            <Button
              variant={appearance.theme === 'light' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => updateTheme('light')}
            >
              Light
            </Button>
            <Button
              variant={appearance.theme === 'dark' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => updateTheme('dark')}
            >
              Dark
            </Button>
            <Button
              variant={appearance.theme === 'system' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => updateTheme('system')}
            >
              System
            </Button>
          </div>
          <div className="flex items-center gap-1.5 bg-muted p-1 rounded-md text-xs font-medium">
            <span className="px-2 text-muted-foreground">Density:</span>
            <Button
              variant={appearance.density === 'comfortable' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => updateDensity('comfortable')}
            >
              Comfortable
            </Button>
            <Button
              variant={appearance.density === 'compact' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => updateDensity('compact')}
            >
              Compact
            </Button>
          </div>
        </div>
      </header>

      {/* Overlays Section (Required for E2E under CSP) */}
      <section aria-labelledby="kitchen-sink-overlays" className="space-y-4">
        <h2
          id="kitchen-sink-overlays"
          className="text-xl font-semibold text-foreground tracking-tight"
        >
          Overlays
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          {/* Dialog (retained for e2e/runtime-styles.spec.ts) */}
          <Dialog>
            <DialogTrigger asChild>
              <Button>Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Approve 3 devices</DialogTitle>
                <DialogDescription>They can be reached from the console at once.</DialogDescription>
              </DialogHeader>
              <DialogFooter showCloseButton />
            </DialogContent>
          </Dialog>

          {/* Dropdown Menu (retained for e2e/runtime-styles.spec.ts) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">Open menu</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Device</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>Approve</DropdownMenuItem>
              <DropdownMenuItem>Reject</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Sheet */}
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="secondary">Open sheet</Button>
            </SheetTrigger>
            <SheetContent side="right">
              <SheetHeader>
                <SheetTitle>Device details</SheetTitle>
                <SheetDescription>Workstation inspect panel and recent sessions.</SheetDescription>
              </SheetHeader>
              <div className="mt-4 space-y-2">
                <p className="text-sm text-foreground">Hostname: lab-worker-01</p>
              </div>
            </SheetContent>
          </Sheet>

          {/* Select */}
          <Select defaultValue="active">
            <SelectTrigger className="w-[180px]" aria-label="Device status">
              <SelectValue placeholder="Device status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="offline">Offline</SelectItem>
            </SelectContent>
          </Select>

          {/* Popover */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">Open popover</Button>
            </PopoverTrigger>
            <PopoverContent>
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Quick Connect URL</h4>
                <p className="text-xs text-muted-foreground">
                  Direct connection protocol endpoint.
                </p>
                <MonoId idText="rustdesk://992-120-441" />
              </div>
            </PopoverContent>
          </Popover>

          {/* Tooltip */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost">Hover or focus tooltip</Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Accessible tooltip payload</p>
            </TooltipContent>
          </Tooltip>

          {/* Toast */}
          <Button
            variant="outline"
            onClick={() =>
              toast({
                title: 'Device approved',
                description: 'lab-node-03 has been admitted to the fleet.',
              })
            }
          >
            Trigger toast
          </Button>

          {/* Command Palette */}
          <Button variant="secondary" onClick={() => setCommandOpen(true)}>
            Open command palette
          </Button>
          <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
            <CommandInput placeholder="Type a command or search devices..." />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup heading="Actions">
                <CommandItem onSelect={() => setCommandOpen(false)}>
                  Approve pending devices
                </CommandItem>
                <CommandItem onSelect={() => setCommandOpen(false)}>
                  Run server health checks
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </CommandDialog>
        </div>
      </section>

      {/* Buttons & Form Controls */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-foreground tracking-tight">Buttons & Controls</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="default">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link Button</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="flex flex-wrap items-center gap-4 max-w-xl">
          <Input placeholder="Enter hostname or IP..." className="max-w-xs" />
          <div className="flex items-center gap-2">
            <Switch id="demo-switch" defaultChecked />
            <label
              htmlFor="demo-switch"
              className="text-sm font-medium text-foreground cursor-pointer"
            >
              Force relay
            </label>
          </div>
        </div>
      </section>

      {/* Tabs */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-foreground tracking-tight">Tabs</h2>
        <Tabs defaultValue="all" className="w-[400px]">
          <TabsList>
            <TabsTrigger value="all">All devices</TabsTrigger>
            <TabsTrigger value="pending">Pending</TabsTrigger>
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
          </TabsList>
          <TabsContent value="all" className="text-sm text-muted-foreground p-2">
            40 approved endpoints registered.
          </TabsContent>
          <TabsContent value="pending" className="text-sm text-muted-foreground p-2">
            3 devices waiting for administrative approval.
          </TabsContent>
          <TabsContent value="sessions" className="text-sm text-muted-foreground p-2">
            2 active remote desktop sessions.
          </TabsContent>
        </Tabs>
      </section>

      {/* Badges Section */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-foreground tracking-tight">Badges</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="default">Primary</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <Badge variant="online">Online</Badge>
          <Badge variant="pending">Pending</Badge>
          <Badge variant="offline">Offline</Badge>
          <Badge variant="alert">Alert</Badge>
          <Badge variant="live">Live</Badge>
        </div>
      </section>

      {/* Status & Brand Components */}
      <section className="space-y-6">
        <h2 className="text-xl font-semibold text-foreground tracking-tight">
          Brand & Status Indicators
        </h2>

        {/* Dynamic Pulse Demonstration */}
        <div
          data-testid="dynamic-pulse-container"
          className="flex items-center gap-4 p-4 border border-border rounded-lg bg-card"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Dynamic status pulse test:</span>
            <StatusDot status={dynamicStatus} size="lg" />
            <span className="text-xs uppercase font-mono text-muted-foreground">
              {dynamicStatus}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={cycleStatus}>
            Trigger status change pulse
          </Button>
        </div>

        {/* Copy Field & Monospace IDs */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Copy Field</CardTitle>
              <CardDescription>Feature detects clipboard with HTTP fallback</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <CopyField label="Setup Token" value="sec_token_9918274aef12" />
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Monospace ID:</span>
                <MonoId idText="72b144fa-d56b-48c2-9099-b1ff88902ce4" truncate />
              </div>
            </CardContent>
            <CardFooter className="text-xs text-muted-foreground border-t border-border pt-4">
              Clipboard operations feature-detect HTTPS.
            </CardFooter>
          </Card>

          {/* Relative Times */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Relative Time</CardTitle>
              <CardDescription>Shared clock updates</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4 text-sm">
                <span>Last heartbeat:</span>
                <RelativeTime date={SAMPLE_DATE_2M} />
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Table & Skeletons */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-foreground tracking-tight">Table & Density</h2>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hostname</TableHead>
                <TableHead>RustDesk ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Seen</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">prod-db-primary</TableCell>
                <TableCell>
                  <MonoId idText="992-019-281" />
                </TableCell>
                <TableCell>Online</TableCell>
                <TableCell>
                  <RelativeTime date={SAMPLE_DATE_1M} />
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm">
                    Connect
                  </Button>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">office-macbook-pro</TableCell>
                <TableCell>
                  <MonoId idText="881-229-401" />
                </TableCell>
                <TableCell>Pending</TableCell>
                <TableCell>
                  <RelativeTime date={SAMPLE_DATE_1H} />
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="outline" size="sm">
                    Review
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>
        <div className="flex gap-4">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-10 w-32" />
        </div>
      </section>

      {/* Empty & Error States */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-foreground tracking-tight">
          Empty & Error States
        </h2>
        <div className="grid gap-6 md:grid-cols-2">
          <EmptyState
            title="No devices pending approval"
            description="When a new RustDesk client connects, it will appear here for review."
            action={<Button size="sm">Invite client</Button>}
          />
          <ErrorState
            error={{
              code: 'network',
              message: 'Could not reach the server. Check your connection.',
            }}
            retry={() => toast({ title: 'Retried fetch', description: 'Reconnected to backend.' })}
          />
        </div>
      </section>
    </main>
  )
}
