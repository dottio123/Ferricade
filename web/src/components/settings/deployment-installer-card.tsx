import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { components } from '@/api/schema'

type Profile = components['schemas']['DeploymentProfile']

interface DeploymentInstallerCardProps {
  profile: Profile
  disabled: boolean
  fieldErrors: Record<string, string>
  onChange: <K extends keyof Profile>(key: K, value: Profile[K]) => void
}

export function DeploymentInstallerCard({
  profile,
  disabled,
  fieldErrors,
  onChange,
}: DeploymentInstallerCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Installer</CardTitle>
        <CardDescription className="text-xs">
          Choose how target devices download and install or update the RustDesk client.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* Include install toggle */}
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3.5 bg-muted/10">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">
              Install or update the RustDesk client
            </span>
            <span className="text-xs text-muted-foreground">
              When enabled, the deployment script installs or updates the client before applying
              settings.
            </span>
          </div>
          <Switch
            checked={profile.include_install}
            onCheckedChange={(checked) => onChange('include_install', checked)}
            disabled={disabled}
            aria-label="Install or update the RustDesk client"
          />
        </div>

        {profile.include_install && (
          <div className="flex flex-col gap-4">
            {/* Installer source */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="installer-source"
                className="text-xs font-medium text-muted-foreground"
              >
                Installer source
              </label>
              <Select
                value={profile.installer_source}
                onValueChange={(val: 'github' | 'url') => {
                  if (val === 'url' && profile.client_version === 'latest')
                    onChange('client_version', '')
                  onChange('installer_source', val)
                }}
                disabled={disabled}
              >
                <SelectTrigger id="installer-source" className="w-full sm:w-64">
                  <SelectValue placeholder="Select installer source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="github">GitHub releases (official)</SelectItem>
                  <SelectItem value="url">Custom download URLs</SelectItem>
                </SelectContent>
              </Select>
              {fieldErrors.installer_source && (
                <span className="text-xs text-destructive">{fieldErrors.installer_source}</span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="client-version-mode"
                className="text-xs font-medium text-muted-foreground"
              >
                Client version
              </label>
              <Select
                value={
                  profile.client_version === 'latest' && profile.installer_source === 'github'
                    ? 'latest'
                    : 'specific'
                }
                onValueChange={(value) => {
                  if (value === 'latest') {
                    onChange('sha256_windows', '')
                    onChange('sha256_deb', '')
                    onChange('sha256_rpm', '')
                  }
                  onChange('client_version', value === 'latest' ? 'latest' : '')
                }}
                disabled={disabled || profile.installer_source === 'url'}
              >
                <SelectTrigger id="client-version-mode" className="w-full sm:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {profile.installer_source === 'github' && (
                    <SelectItem value="latest">Latest release</SelectItem>
                  )}
                  <SelectItem value="specific">Specific version</SelectItem>
                </SelectContent>
              </Select>
              {profile.client_version === 'latest' && profile.installer_source === 'github' ? (
                <span className="text-xs text-muted-foreground">
                  Each script asks GitHub for the newest RustDesk release when it runs.
                </span>
              ) : (
                <>
                  <label
                    htmlFor="specific-version"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Specific version
                  </label>
                  <Input
                    id="specific-version"
                    value={profile.client_version}
                    onChange={(e) => onChange('client_version', e.target.value)}
                    disabled={disabled}
                    placeholder="1.5.0"
                    className="w-full sm:w-64"
                    aria-invalid={Boolean(fieldErrors.client_version)}
                  />
                  {fieldErrors.client_version && (
                    <span className="text-xs text-destructive">{fieldErrors.client_version}</span>
                  )}
                </>
              )}
            </div>
            {profile.installer_source === 'url' && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <label
                    htmlFor="url-windows"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Windows installer URL or path
                  </label>
                  <Input
                    id="url-windows"
                    value={profile.url_windows}
                    onChange={(e) => onChange('url_windows', e.target.value)}
                    disabled={disabled}
                    placeholder="https://... or \\server\share\rustdesk.exe"
                    aria-invalid={Boolean(fieldErrors.url_windows)}
                  />
                  <span className="text-xs text-muted-foreground">
                    An HTTPS URL or UNC network share path (\server\share) to the Windows installer.
                  </span>
                  {fieldErrors.url_windows && (
                    <span className="text-xs text-destructive">{fieldErrors.url_windows}</span>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="url-deb" className="text-xs font-medium text-muted-foreground">
                    Linux .deb package URL
                  </label>
                  <Input
                    id="url-deb"
                    value={profile.url_deb}
                    onChange={(e) => onChange('url_deb', e.target.value)}
                    disabled={disabled}
                    placeholder="https://.../rustdesk.deb"
                    aria-invalid={Boolean(fieldErrors.url_deb)}
                  />
                  {fieldErrors.url_deb && (
                    <span className="text-xs text-destructive">{fieldErrors.url_deb}</span>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="url-rpm" className="text-xs font-medium text-muted-foreground">
                    Linux .rpm package URL
                  </label>
                  <Input
                    id="url-rpm"
                    value={profile.url_rpm}
                    onChange={(e) => onChange('url_rpm', e.target.value)}
                    disabled={disabled}
                    placeholder="https://.../rustdesk.rpm"
                    aria-invalid={Boolean(fieldErrors.url_rpm)}
                  />
                  {fieldErrors.url_rpm && (
                    <span className="text-xs text-destructive">{fieldErrors.url_rpm}</span>
                  )}
                </div>
              </div>
            )}

            {/* Optional SHA-256 checksums */}
            {profile.client_version !== 'latest' && (
              <div className="flex flex-col gap-3 rounded-lg border border-border/80 bg-muted/20 p-4">
                <div>
                  <span className="text-xs font-semibold text-foreground">
                    Package checksums (optional)
                  </span>
                  <p className="text-xs text-muted-foreground">
                    Optional 64-character SHA-256 hex checksums to verify downloaded installers.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="sha256-windows"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Windows SHA-256
                    </label>
                    <Input
                      id="sha256-windows"
                      value={profile.sha256_windows}
                      onChange={(e) => onChange('sha256_windows', e.target.value)}
                      disabled={disabled}
                      placeholder="Optional 64 hex chars"
                      className="font-mono text-xs"
                      aria-invalid={Boolean(fieldErrors.sha256_windows)}
                    />
                    {fieldErrors.sha256_windows && (
                      <span className="text-xs text-destructive">{fieldErrors.sha256_windows}</span>
                    )}
                  </div>

                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="sha256-deb"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Debian/Ubuntu (.deb) SHA-256
                    </label>
                    <Input
                      id="sha256-deb"
                      value={profile.sha256_deb}
                      onChange={(e) => onChange('sha256_deb', e.target.value)}
                      disabled={disabled}
                      placeholder="Optional 64 hex chars"
                      className="font-mono text-xs"
                      aria-invalid={Boolean(fieldErrors.sha256_deb)}
                    />
                    {fieldErrors.sha256_deb && (
                      <span className="text-xs text-destructive">{fieldErrors.sha256_deb}</span>
                    )}
                  </div>

                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="sha256-rpm"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      RHEL/Fedora (.rpm) SHA-256
                    </label>
                    <Input
                      id="sha256-rpm"
                      value={profile.sha256_rpm}
                      onChange={(e) => onChange('sha256_rpm', e.target.value)}
                      disabled={disabled}
                      placeholder="Optional 64 hex chars"
                      className="font-mono text-xs"
                      aria-invalid={Boolean(fieldErrors.sha256_rpm)}
                    />
                    {fieldErrors.sha256_rpm && (
                      <span className="text-xs text-destructive">{fieldErrors.sha256_rpm}</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Allow downgrade toggle */}
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-foreground">Allow downgrade</span>
                <span className="text-xs text-muted-foreground">
                  Allow running the installer if the already installed client is newer than the
                  target version.
                </span>
              </div>
              <Switch
                checked={profile.allow_downgrade}
                onCheckedChange={(checked) => onChange('allow_downgrade', checked)}
                disabled={disabled}
                aria-label="Allow downgrade"
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
