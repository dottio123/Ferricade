import type { components } from '@/api/schema'
import { CopyField } from '@/components/brand/copy-field'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

export interface ClientConfigProps {
  config: components['schemas']['ClientConfig']
  className?: string
}

export function ClientConfig({ config, className }: ClientConfigProps) {
  return (
    <div data-slot="client-config" className={cn('flex flex-col gap-6 text-left', className)}>
      {/* 1. Main config string */}
      <div className="flex flex-col gap-1.5">
        <CopyField value={config.config_string} label="Server configuration string" />
        <p className="text-xs text-muted-foreground">
          In the RustDesk client, go to Settings → Network → ID/Relay server, and click
          &ldquo;Import server config&rdquo;.
        </p>
      </div>

      {/* 2. Direct server parameters */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Individual connection parameters
        </span>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CopyField value={config.host} label="ID Server" />
          <CopyField value={config.relay} label="Relay Server" />
          <CopyField value={config.key} label="Public Key" />
          <CopyField value={config.api} label="API Server" />
        </div>
      </div>

      {/* 3. OS Install Commands in Tabs */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Import with the command line
        </span>
        <p className="text-xs text-muted-foreground">
          On a computer where RustDesk is already installed: run it in PowerShell as administrator
          on Windows, or in a terminal on macOS and Linux (it uses sudo).
        </p>
        <Tabs defaultValue="windows" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="windows">Windows</TabsTrigger>
            <TabsTrigger value="macos">macOS</TabsTrigger>
            <TabsTrigger value="linux">Linux</TabsTrigger>
          </TabsList>
          <TabsContent value="windows" className="mt-2">
            <CopyField value={config.install.windows} label="Windows (PowerShell)" />
          </TabsContent>
          <TabsContent value="macos" className="mt-2">
            <CopyField value={config.install.macos} label="macOS (Terminal)" />
          </TabsContent>
          <TabsContent value="linux" className="mt-2">
            <CopyField value={config.install.linux} label="Linux (Terminal)" />
          </TabsContent>
        </Tabs>
      </div>

      {/* 4. Deep Link */}
      <div className="flex flex-col gap-1.5">
        <CopyField value={config.deep_link} label="Configuration link" />
        <p className="text-xs text-muted-foreground">
          Mobile clients only (iOS and Android builds configured to accept config links).
        </p>
      </div>
    </div>
  )
}
