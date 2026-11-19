import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AlertCircleIcon, DownloadIcon, ShieldAlertIcon } from 'lucide-react'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import { useToast } from '@/components/ui/toast'
import { queryKeys } from '@/lib/queryKeys'
import type { components } from '@/api/schema'

type Profile = components['schemas']['DeploymentProfile']

interface DeploymentDownloadCardProps {
  profile: Profile
  hasUnsavedChanges?: boolean
}

export function DeploymentDownloadCard({
  profile,
  hasUnsavedChanges = false,
}: DeploymentDownloadCardProps) {
  const { toast } = useToast()
  const [downloading, setDownloading] = React.useState<'windows' | 'linux' | null>(null)

  const policyPushQuery = useQuery({
    queryKey: queryKeys.policyPush(),
    queryFn: () => unwrap(api.GET('/admin/api/v1/settings/policy-push')),
  })

  const showPasswordWarning = profile.include_password && !profile.password.set
  const showPINWarning = profile.include_unlock_pin && !profile.unlock_pin.set
  const includedSettings = Object.values(profile.settings).filter(
    (setting) => setting.include,
  ).length
  const installSummary = profile.include_install
    ? `${profile.client_version === 'latest' ? 'Installs the latest RustDesk release' : `Installs RustDesk ${profile.client_version}`} or updates an older version${profile.allow_downgrade ? ' or replaces a newer one' : ''}${profile.installer_source === 'github' ? ' (from GitHub)' : ' (from your download URLs)'}`
    : 'Leaves RustDesk as installed (it must already be installed)'
  const passwordSummary = !profile.include_password
    ? "Leaves the device's password unchanged"
    : profile.password.set
      ? 'Sets the fleet password'
      : "Removes the device's permanent password"
  const pinSummary = !profile.include_unlock_pin
    ? 'Leaves the settings unlock PIN unchanged'
    : profile.unlock_pin.set
      ? 'Sets the settings unlock PIN'
      : 'Removes the settings unlock PIN'
  const hasPasswordInFile = profile.include_password && profile.password.set
  const hasPINInFile = profile.include_unlock_pin && profile.unlock_pin.set
  const secretNotice =
    hasPasswordInFile && hasPINInFile
      ? 'The file contains the fleet password and the unlock PIN: store it like a secret. Run it elevated (Administrator/SYSTEM, root).'
      : hasPasswordInFile
        ? 'The file contains the fleet password: store it like a secret. Run it elevated (Administrator/SYSTEM, root).'
        : hasPINInFile
          ? 'The file contains the unlock PIN: store it like a secret. Run it elevated (Administrator/SYSTEM, root).'
          : 'Run it elevated (Administrator/SYSTEM, root).'

  const handleDownload = async (os: 'windows' | 'linux') => {
    try {
      setDownloading(os)
      const res = await api.POST('/admin/api/v1/deployment/script', {
        body: { os },
        parseAs: 'text',
      } as Parameters<typeof api.POST<'/admin/api/v1/deployment/script'>>[1] & {
        parseAs: 'text'
      })
      const ext = os === 'windows' ? '.ps1' : '.sh'
      let filename = `ferricade-deploy${ext}`
      const disp = res.response.headers.get('Content-Disposition')
      if (disp) {
        const match = /filename="?([^";]+)"?/.exec(disp)
        if (match?.[1]) filename = match[1].trim()
      }
      const blob = new Blob([res.data ?? ''], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      setTimeout(() => {
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }, 1000)
    } catch (err) {
      toast({
        title: 'Failed to download deployment script',
        description: describeError(err).message,
        variant: 'destructive',
      })
    } finally {
      setDownloading(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Download deployment scripts</CardTitle>
        <CardDescription className="text-xs">
          Generate ready-to-run installation scripts for Windows and Linux fleets.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="text-xs text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">Each script, run elevated on a device:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{installSummary}</li>
            <li>
              Connects RustDesk to this server: ID server, relay server, public key and API server
              (the client configuration on the Settings page)
            </li>
            {includedSettings > 0 && (
              <li>
                Applies {includedSettings} client setting{includedSettings === 1 ? '' : 's'} (those
                that apply to the device's system)
              </li>
            )}
            <li>{passwordSummary}</li>
            <li>{pinSummary}</li>
          </ul>
        </div>

        {/* Warning if include_password is on but not set */}
        {showPasswordWarning && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive">
            <AlertCircleIcon className="size-4 shrink-0" />
            <span>
              No fleet password is set: the script removes the permanent password from every device
              it runs on.
            </span>
          </div>
        )}
        {showPINWarning && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive">
            <AlertCircleIcon className="size-4 shrink-0" />
            <span>
              No unlock PIN is set: the script removes the settings unlock PIN from every device it
              runs on.
            </span>
          </div>
        )}

        {/* Permanent secret notice */}
        <div className="flex items-start gap-2.5 rounded-lg border border-border/80 bg-muted/30 p-3.5 text-xs text-muted-foreground leading-relaxed">
          <ShieldAlertIcon className="size-4 shrink-0 text-muted-foreground mt-0.5" />
          <span>{secretNotice}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Script exit codes: 10: elevation required; 20: download or checksum failed; 21: latest
          release lookup failed; 30: installation or service failed; 40: configuration failed; 50:
          existing Windows EXE installation.
        </p>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          {hasUnsavedChanges && (
            <p className="w-full text-xs text-muted-foreground">
              You have unsaved changes. Save them first: the script is built from the saved
              settings.
            </p>
          )}
          <Button
            type="button"
            onClick={() => handleDownload('windows')}
            disabled={downloading !== null || hasUnsavedChanges}
            className="flex items-center gap-2"
          >
            <DownloadIcon className="size-4" />
            <span>{downloading === 'windows' ? 'Generating…' : 'Windows (.ps1)'}</span>
          </Button>

          <Button
            type="button"
            onClick={() => handleDownload('linux')}
            disabled={downloading !== null || hasUnsavedChanges}
            className="flex items-center gap-2"
          >
            <DownloadIcon className="size-4" />
            <span>{downloading === 'linux' ? 'Generating…' : 'Linux (.sh)'}</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            disabled
            className="opacity-60 cursor-not-allowed"
          >
            macOS: coming later
          </Button>
        </div>

        {policyPushQuery.data?.enabled && (
          <p className="text-xs text-muted-foreground">
            Settings managed by a policy override this script&apos;s values within about 15 seconds.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
