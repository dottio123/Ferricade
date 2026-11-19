import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import { useMe } from '@/auth/session'
import { ErrorState } from '@/components/brand/error-state'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/page-header'
import { idAllowListQueryOptions } from '@/lib/queries'
import { ShieldAlertIcon } from 'lucide-react'
import type { components } from '@/api/schema'
import { DeploymentInstallerCard } from './deployment-installer-card'
import { DeploymentSecretsCard } from './deployment-secrets-card'
import { DeploymentSettingsCard } from './deployment-settings-card'
import { DeploymentDownloadCard } from './deployment-download-card'

type Profile = components['schemas']['DeploymentProfile']
type PutBody = components['schemas']['DeploymentProfilePut']

export const deploymentProfileQueryKey = ['deployment', 'profile'] as const

function parseFieldErrors(message: string): {
  fieldErrors: Record<string, string>
  formError: string | null
} {
  const fields = [
    'installer_source',
    'client_version',
    'url_windows',
    'url_deb',
    'url_rpm',
    'sha256_windows',
    'sha256_deb',
    'sha256_rpm',
    'allow_downgrade',
    'include_install',
    'include_password',
    'include_unlock_pin',
    'include_id_allow_list',
  ]
  for (const field of fields) {
    if (message.includes(field)) {
      return { fieldErrors: { [field]: message }, formError: null }
    }
  }
  return { fieldErrors: {}, formError: message }
}

interface DeploymentSettingsFormProps {
  initial: Profile
  isOwner: boolean
}

function DeploymentSettingsForm({ initial, isOwner }: DeploymentSettingsFormProps) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { data: me } = useMe()
  const role = me?.user.role
  const allowListVisible = role === 'owner' || role === 'admin'

  const allowListQuery = useQuery({
    ...idAllowListQueryOptions,
    enabled: allowListVisible,
    retry: false,
  })
  const isGlobalAllowListEmpty =
    allowListVisible && !allowListQuery.error && allowListQuery.data?.ids?.length === 0

  const [form, setForm] = React.useState<Profile>(initial)
  const [savedProfile, setSavedProfile] = React.useState<Profile>(initial)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})
  const [formError, setFormError] = React.useState<string | null>(null)

  const saveProfileMutation = useMutation({
    mutationFn: async (body: PutBody) => {
      return unwrap(
        api.PUT('/admin/api/v1/deployment/profile', {
          body,
        }),
      )
    },
    onSuccess: (saved) => {
      setFieldErrors({})
      setFormError(null)
      setForm(saved)
      setSavedProfile(saved)
      queryClient.setQueryData(deploymentProfileQueryKey, saved)
      void queryClient.invalidateQueries({ queryKey: deploymentProfileQueryKey })
      toast({ title: 'Deployment profile saved' })
    },
    onError: (err) => {
      const msg = describeError(err).message
      const { fieldErrors: fe, formError: foe } = parseFieldErrors(msg)
      setFieldErrors(fe)
      setFormError(foe)
    },
  })

  const saveSecretMutation = useMutation({
    mutationFn: async (secrets: { fleet_password?: string | null; unlock_pin?: string | null }) => {
      const savedProfile = queryClient.getQueryData<Profile>(deploymentProfileQueryKey) ?? initial
      const body: PutBody = {
        installer_source: savedProfile.installer_source,
        client_version: savedProfile.client_version,
        url_windows: savedProfile.url_windows,
        url_deb: savedProfile.url_deb,
        url_rpm: savedProfile.url_rpm,
        sha256_windows: savedProfile.sha256_windows,
        sha256_deb: savedProfile.sha256_deb,
        sha256_rpm: savedProfile.sha256_rpm,
        allow_downgrade: savedProfile.allow_downgrade,
        include_install: savedProfile.include_install,
        include_password: savedProfile.include_password,
        include_unlock_pin: savedProfile.include_unlock_pin,
        include_id_allow_list: savedProfile.include_id_allow_list,
        settings: savedProfile.settings,
        ...secrets,
      }
      return unwrap(
        api.PUT('/admin/api/v1/deployment/profile', {
          body,
        }),
      )
    },
    onSuccess: (saved, variables) => {
      // Keep user's unsaved edits in the form, only update secret states and updated_at
      setForm((prev) => ({
        ...prev,
        password: saved.password,
        unlock_pin: saved.unlock_pin,
        updated_at: saved.updated_at,
      }))
      setSavedProfile(saved)
      queryClient.setQueryData(deploymentProfileQueryKey, saved)
      void queryClient.invalidateQueries({ queryKey: deploymentProfileQueryKey })
      if (variables.fleet_password !== undefined) {
        toast({
          title: variables.fleet_password === null ? 'Password removed' : 'Password set',
        })
      }
      if (variables.unlock_pin !== undefined) {
        toast({
          title: variables.unlock_pin === null ? 'Unlock PIN removed' : 'Unlock PIN set',
        })
      }
    },
    onError: (err) => {
      const msg = describeError(err).message
      toast({
        title: 'Failed to update secret',
        description: msg,
        variant: 'destructive',
      })
    },
  })

  const handleFieldChange = <K extends keyof Profile>(key: K, value: Profile[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    if (fieldErrors[key]) {
      setFieldErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  const handleSettingToggle = (settingKey: string, include: boolean) => {
    setForm((prev) => {
      const current = prev.settings[settingKey] ?? {
        include: false,
        value:
          prev.catalog.find((c) => c.key === settingKey)?.default ||
          (prev.catalog.find((c) => c.key === settingKey)?.type === 'bool' ? 'N' : ''),
      }
      return {
        ...prev,
        settings: {
          ...prev.settings,
          [settingKey]: {
            ...current,
            include,
          },
        },
      }
    })
  }

  const handleSettingValueChange = (settingKey: string, value: string) => {
    setForm((prev) => {
      const current = prev.settings[settingKey] ?? {
        include: true,
        value,
      }
      return {
        ...prev,
        settings: {
          ...prev.settings,
          [settingKey]: {
            ...current,
            value,
          },
        },
      }
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isOwner) return
    setFieldErrors({})
    setFormError(null)

    const putBody: PutBody = {
      installer_source: form.installer_source,
      client_version: form.client_version,
      url_windows: form.url_windows,
      url_deb: form.url_deb,
      url_rpm: form.url_rpm,
      sha256_windows: form.sha256_windows,
      sha256_deb: form.sha256_deb,
      sha256_rpm: form.sha256_rpm,
      allow_downgrade: form.allow_downgrade,
      include_install: form.include_install,
      include_password: form.include_password,
      include_unlock_pin: form.include_unlock_pin,
      include_id_allow_list: form.include_id_allow_list,
      settings: form.settings,
    }
    saveProfileMutation.mutate(putBody)
  }

  const formSettings = {
    installer_source: form.installer_source,
    client_version: form.client_version,
    url_windows: form.url_windows,
    url_deb: form.url_deb,
    url_rpm: form.url_rpm,
    sha256_windows: form.sha256_windows,
    sha256_deb: form.sha256_deb,
    sha256_rpm: form.sha256_rpm,
    allow_downgrade: form.allow_downgrade,
    include_install: form.include_install,
    include_password: form.include_password,
    include_unlock_pin: form.include_unlock_pin,
    include_id_allow_list: form.include_id_allow_list,
    settings: form.settings,
  }
  const savedSettings = {
    installer_source: savedProfile.installer_source,
    client_version: savedProfile.client_version,
    url_windows: savedProfile.url_windows,
    url_deb: savedProfile.url_deb,
    url_rpm: savedProfile.url_rpm,
    sha256_windows: savedProfile.sha256_windows,
    sha256_deb: savedProfile.sha256_deb,
    sha256_rpm: savedProfile.sha256_rpm,
    allow_downgrade: savedProfile.allow_downgrade,
    include_install: savedProfile.include_install,
    include_password: savedProfile.include_password,
    include_unlock_pin: savedProfile.include_unlock_pin,
    include_id_allow_list: savedProfile.include_id_allow_list,
    settings: savedProfile.settings,
  }
  const hasUnsavedChanges = JSON.stringify(formSettings) !== JSON.stringify(savedSettings)

  return (
    <div className="flex flex-col gap-8 w-full max-w-4xl mx-auto">
      <PageHeader
        title="Deployment"
        description="Configure unattended deployment scripts, fleet passwords, and client settings."
        backLink={{ to: '/settings', label: 'Settings' }}
      />

      {!isOwner && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <ShieldAlertIcon className="size-4 shrink-0 text-muted-foreground" />
          <span>
            Only owners can edit deployment settings. Values are displayed in read-only mode.
          </span>
        </div>
      )}

      {formError && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
        >
          {formError}
        </div>
      )}

      <form id="deployment-profile-form" onSubmit={handleSubmit} className="flex flex-col gap-8">
        {/* 1. Installer configuration */}
        <DeploymentInstallerCard
          profile={form}
          disabled={!isOwner || saveProfileMutation.isPending}
          fieldErrors={fieldErrors}
          onChange={handleFieldChange}
        />

        {/* 2. Client settings */}
        <DeploymentSettingsCard
          catalog={form.catalog}
          settings={form.settings}
          disabled={!isOwner || saveProfileMutation.isPending}
          onToggleInclude={handleSettingToggle}
          onValueChange={handleSettingValueChange}
        />
      </form>

      {/* 3. Fleet secrets (kept outside <form> so dialog form submits do not bubble into it) */}
      <DeploymentSecretsCard
        profile={form}
        disabled={!isOwner || saveProfileMutation.isPending}
        isGlobalAllowListEmpty={isGlobalAllowListEmpty}
        onToggleIncludePassword={(inc) => handleFieldChange('include_password', inc)}
        onToggleIncludePIN={(inc) => handleFieldChange('include_unlock_pin', inc)}
        onToggleIncludeIdAllowList={(inc) => handleFieldChange('include_id_allow_list', inc)}
        onSaveSecret={async (secrets) => {
          await saveSecretMutation.mutateAsync(secrets)
        }}
      />

      {/* Save button for owner */}
      {isOwner && (
        <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
          <Button
            type="submit"
            form="deployment-profile-form"
            disabled={saveProfileMutation.isPending}
          >
            {saveProfileMutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}

      {/* 4. Download section */}
      <DeploymentDownloadCard profile={savedProfile} hasUnsavedChanges={hasUnsavedChanges} />
    </div>
  )
}

export function DeploymentSettingsView() {
  const { data: me } = useMe()
  const isOwner = me?.user.role === 'owner'

  const {
    data: profile,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: deploymentProfileQueryKey,
    queryFn: () => unwrap(api.GET('/admin/api/v1/deployment/profile')),
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 w-full max-w-4xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
        <div className="flex flex-col gap-4 mt-4">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  if (error || !profile) {
    return (
      <div className="flex flex-col gap-6 w-full max-w-4xl mx-auto">
        <PageHeader
          title="Deployment"
          description="Prepare unattended RustDesk deployment scripts for Windows and Linux fleets."
          backLink={{ to: '/settings', label: 'Settings' }}
        />
        <ErrorState
          title="Failed to load deployment profile"
          error={error}
          retry={() => void refetch()}
        />
      </div>
    )
  }

  return <DeploymentSettingsForm initial={profile} isOwner={isOwner} />
}
