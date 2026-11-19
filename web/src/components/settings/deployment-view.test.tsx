import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { components } from '@/api/schema'
import { ToasterProvider } from '@/components/ui/toast'
import {
  hasForbiddenSecretChars,
  validatePasswordRules,
  validatePinRules,
  DeploymentSecretsCard,
} from './deployment-secrets-card'
import { DeploymentInstallerCard } from './deployment-installer-card'
import { DeploymentSettingsCard } from './deployment-settings-card'
import { DeploymentDownloadCard } from './deployment-download-card'
import { DeploymentSettingsView } from './deployment-view'

const apiMock = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), POST: vi.fn() }))
const sessionMock = vi.hoisted(() => ({
  useMe: vi.fn(() => ({ data: { user: { role: 'owner' } } })),
}))
vi.mock('@/api/client', () => ({
  api: apiMock,
  unwrap: async (promise: Promise<{ data?: unknown }>) => (await promise).data,
}))
vi.mock('@/auth/session', () => ({ useMe: () => sessionMock.useMe() }))
vi.mock('@/components/page-header', () => ({ PageHeader: () => null }))

afterEach(() => {
  cleanup()
  sessionMock.useMe.mockReturnValue({ data: { user: { role: 'owner' } } })
})

type Profile = components['schemas']['DeploymentProfile']

const baseProfile: Profile = {
  installer_source: 'github',
  client_version: '1.5.0',
  url_windows: '',
  url_deb: '',
  url_rpm: '',
  sha256_windows: '',
  sha256_deb: '',
  sha256_rpm: '',
  allow_downgrade: false,
  include_install: true,
  include_password: false,
  include_unlock_pin: false,
  include_id_allow_list: false,
  settings: {},
  catalog: [
    {
      key: 'enable-lan-discovery',
      label: 'Visible on the local network',
      help: "Other RustDesk devices on the same network can find this device. RustDesk's default: on.",
      type: 'bool',
      values: [],
      value_labels: { Y: 'On', N: 'Off' },
      default: '',
      os: ['windows', 'linux', 'macos'],
      source: 'config.rs:1',
    },
    {
      key: 'windows-feature',
      label: 'Windows special feature',
      help: 'A feature only for Windows machines.',
      type: 'bool',
      values: [],
      value_labels: { Y: 'On', N: 'Off' },
      default: '',
      os: ['windows'],
      source: 'win.rs:1',
    },
    {
      key: 'approve-mode',
      label: 'How incoming connections are accepted',
      help: 'Whether someone connecting needs the password, needs the person at the device to click Accept, or either.',
      type: 'enum',
      values: ['password', 'click', 'password-click'],
      value_labels: {
        password: 'Password only',
        click: 'Click to accept only',
        'password-click': 'Password or click',
      },
      default: '',
      os: ['windows', 'linux', 'macos'],
      source: 'config.rs:2',
    },
  ],
  password: { set: false, set_at: null, set_by: null },
  unlock_pin: { set: false, set_at: null, set_by: null },
  updated_at: null,
}

describe('Deployment secrets validation', () => {
  it('identifies forbidden quote, backslash, and control characters', () => {
    expect(hasForbiddenSecretChars('validPassword1')).toBe(false)
    expect(hasForbiddenSecretChars('with"quote')).toBe(true)
    expect(hasForbiddenSecretChars('with\\backslash')).toBe(true)
    expect(hasForbiddenSecretChars('with\x00null')).toBe(true)
    expect(hasForbiddenSecretChars('with\x1funit')).toBe(true)
    expect(hasForbiddenSecretChars('with\x7fdelete')).toBe(true)
  })

  it('validates fleet password rules', () => {
    // Too short (< 8)
    expect(validatePasswordRules('Short1A').allMet).toBe(false)
    // Missing upper
    expect(validatePasswordRules('lowercase123').upperMet).toBe(false)
    // Missing lower
    expect(validatePasswordRules('UPPERCASE123').lowerMet).toBe(false)
    // Missing digit
    expect(validatePasswordRules('NoDigitsHere').digitMet).toBe(false)
    // Forbidden char
    expect(validatePasswordRules('GoodPass1"').noForbidden).toBe(false)
    // Valid password
    const valid = validatePasswordRules('ValidPass123')
    expect(valid.allMet).toBe(true)
    expect(valid.lengthMet).toBe(true)
    expect(valid.upperMet).toBe(true)
    expect(valid.lowerMet).toBe(true)
    expect(valid.digitMet).toBe(true)
    expect(valid.noForbidden).toBe(true)
  })

  it('validates settings unlock PIN rules', () => {
    // Too short (< 4)
    expect(validatePinRules('123').allMet).toBe(false)
    // Forbidden char
    expect(validatePinRules('12"4').noForbidden).toBe(false)
    // Valid PIN
    expect(validatePinRules('1234').allMet).toBe(true)
    expect(validatePinRules('SecurityPIN-42').allMet).toBe(true)
  })
})

describe('DeploymentInstallerCard', () => {
  it('offers latest release for GitHub and a specific version field', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <DeploymentInstallerCard
        profile={{ ...baseProfile, client_version: 'latest' }}
        disabled={false}
        fieldErrors={{}}
        onChange={onChange}
      />,
    )
    expect(
      screen.getByText('Each script asks GitHub for the newest RustDesk release when it runs.'),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Specific version')).toBeNull()
    expect(screen.queryByLabelText('Windows SHA-256')).toBeNull()
    fireEvent.click(screen.getByRole('combobox', { name: 'Client version' }))
    fireEvent.click(screen.getByRole('option', { name: 'Specific version' }))
    expect(onChange).toHaveBeenCalledWith('client_version', '')
    rerender(
      <DeploymentInstallerCard
        profile={{ ...baseProfile, client_version: '' }}
        disabled={false}
        fieldErrors={{ client_version: 'must be major.minor.patch' }}
        onChange={onChange}
      />,
    )
    expect(screen.getByLabelText('Specific version')).toHaveValue('')
    expect(screen.getByText('must be major.minor.patch')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('combobox', { name: 'Client version' }))
    fireEvent.click(screen.getByRole('option', { name: 'Latest release' }))
    expect(onChange).toHaveBeenCalledWith('client_version', 'latest')
    expect(onChange).toHaveBeenCalledWith('sha256_windows', '')
    expect(onChange).toHaveBeenCalledWith('sha256_deb', '')
    expect(onChange).toHaveBeenCalledWith('sha256_rpm', '')
  })

  it('hides latest for custom URLs and clears it when switching sources', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <DeploymentInstallerCard
        profile={{ ...baseProfile, client_version: 'latest' }}
        disabled={false}
        fieldErrors={{}}
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Installer source' }))
    fireEvent.click(screen.getByRole('option', { name: 'Custom download URLs' }))
    expect(onChange).toHaveBeenCalledWith('client_version', '')
    expect(onChange).toHaveBeenCalledWith('installer_source', 'url')
    rerender(
      <DeploymentInstallerCard
        profile={{ ...baseProfile, installer_source: 'url', client_version: '' }}
        disabled={false}
        fieldErrors={{}}
        onChange={onChange}
      />,
    )
    expect(screen.queryByText('Latest release')).toBeNull()
  })
  it('renders installer toggle and inputs', () => {
    const onChange = vi.fn()
    render(
      <DeploymentInstallerCard
        profile={baseProfile}
        disabled={false}
        fieldErrors={{}}
        onChange={onChange}
      />,
    )

    expect(screen.getByText('Installer')).toBeDefined()
    expect(screen.getByLabelText('Install or update the RustDesk client')).toBeDefined()
    expect(screen.getByLabelText('Specific version')).toHaveValue('1.5.0')

    const versionInput = screen.getByLabelText('Specific version')
    fireEvent.change(versionInput, { target: { value: '1.5.5' } })
    expect(onChange).toHaveBeenCalledWith('client_version', '1.5.5')
  })

  it('renders custom url fields when installer_source is url', () => {
    const urlProfile: Profile = {
      ...baseProfile,
      installer_source: 'url',
      url_windows: 'https://example.com/win.exe',
      url_deb: 'https://example.com/app.deb',
    }
    render(
      <DeploymentInstallerCard
        profile={urlProfile}
        disabled={false}
        fieldErrors={{}}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Windows installer URL or path')).toHaveValue(
      'https://example.com/win.exe',
    )
    expect(screen.getByLabelText('Linux .deb package URL')).toHaveValue(
      'https://example.com/app.deb',
    )
    expect(screen.getByLabelText('Linux .rpm package URL')).toBeDefined()
  })
})

describe('DeploymentSecretsCard', () => {
  it('shows Not set when secrets are not configured', () => {
    render(
      <ToasterProvider>
        <DeploymentSecretsCard
          profile={baseProfile}
          disabled={false}
          isGlobalAllowListEmpty={false}
          onToggleIncludePassword={vi.fn()}
          onToggleIncludePIN={vi.fn()}
          onToggleIncludeIdAllowList={vi.fn()}
          onSaveSecret={vi.fn()}
        />
      </ToasterProvider>,
    )

    expect(screen.getByText('Secrets and security')).toBeDefined()
    expect(screen.getAllByText('Not set')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Set fleet password' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Set unlock PIN' })).toBeDefined()
  })

  it('shows set status and remove buttons when secrets are configured', () => {
    const configuredProfile: Profile = {
      ...baseProfile,
      password: {
        set: true,
        set_at: '2026-10-15T12:00:00Z',
        set_by: { id: '00000000-0000-0000-0000-000000000001', display_name: 'Admin User' },
      },
      unlock_pin: {
        set: true,
        set_at: '2026-10-15T12:00:00Z',
        set_by: { id: '00000000-0000-0000-0000-000000000001', display_name: 'Admin User' },
      },
    }

    render(
      <ToasterProvider>
        <DeploymentSecretsCard
          profile={configuredProfile}
          disabled={false}
          isGlobalAllowListEmpty={false}
          onToggleIncludePassword={vi.fn()}
          onToggleIncludePIN={vi.fn()}
          onToggleIncludeIdAllowList={vi.fn()}
          onSaveSecret={vi.fn()}
        />
      </ToasterProvider>,
    )

    expect(screen.getByRole('button', { name: 'Change password' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Remove fleet password' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Change PIN' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Remove unlock PIN' })).toBeDefined()
    expect(screen.getAllByText(/Set on .* by Admin User/i)).toHaveLength(2)
  })
})

describe('DeploymentSettingsCard', () => {
  it('explains the permission preset under permission rows', () => {
    render(
      <DeploymentSettingsCard
        catalog={[
          {
            key: 'enable-file-transfer',
            label: 'File transfer',
            help: 'Share files',
            type: 'bool',
            values: [],
            value_labels: { Y: 'On', N: 'Off' },
            default: '',
            os: ['windows'],
            source: 'keys.rs:40',
          },
        ]}
        settings={{}}
        disabled={false}
        onToggleInclude={vi.fn()}
        onValueChange={vi.fn()}
      />,
    )
    expect(
      screen.getByText(
        "Managing a permission also sets the device's permission preset to Custom, otherwise Full access would override it.",
      ),
    ).toBeInTheDocument()
  })
  it('renders settings catalog entries with labels, help, and OS badges', () => {
    const onToggleInclude = vi.fn()
    const onValueChange = vi.fn()

    render(
      <DeploymentSettingsCard
        catalog={baseProfile.catalog}
        settings={{
          'enable-lan-discovery': { include: true, value: 'Y' },
        }}
        disabled={false}
        onToggleInclude={onToggleInclude}
        onValueChange={onValueChange}
      />,
    )

    expect(screen.getByText('Visible on the local network')).toBeDefined()
    expect(
      screen.getByText(
        "Other RustDesk devices on the same network can find this device. RustDesk's default: on.",
      ),
    ).toBeDefined()
    expect(screen.getByText('Windows only')).toBeDefined()
  })

  it('shows plain option labels', () => {
    render(
      <DeploymentSettingsCard
        catalog={baseProfile.catalog}
        settings={{ 'approve-mode': { include: true, value: 'password-click' } }}
        disabled={false}
        onToggleInclude={vi.fn()}
        onValueChange={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('combobox', { name: 'How incoming connections are accepted value' })
        .textContent,
    ).toContain('Password or click')
  })
})

const createDownloadWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ToasterProvider>{children}</ToasterProvider>
    </QueryClientProvider>
  )
}

describe('DeploymentDownloadCard', () => {
  it('summarizes latest release with downgrade wording', () => {
    render(
      <ToasterProvider>
        <DeploymentDownloadCard
          profile={{ ...baseProfile, client_version: 'latest', allow_downgrade: true }}
        />
      </ToasterProvider>,
      { wrapper: createDownloadWrapper() },
    )
    expect(
      screen.getByText(
        'Installs the latest RustDesk release or updates an older version or replaces a newer one (from GitHub)',
      ),
    ).toBeInTheDocument()
  })
  it('renders download buttons and permanent elevation note', () => {
    render(<DeploymentDownloadCard profile={baseProfile} />, { wrapper: createDownloadWrapper() })

    expect(screen.getByRole('button', { name: 'Windows (.ps1)' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Linux (.sh)' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'macOS: coming later' })).toBeDisabled()
    expect(screen.getByText('Run it elevated (Administrator/SYSTEM, root).')).toBeDefined()
    expect(screen.getByText(/21: latest release lookup failed/)).toBeInTheDocument()
  })

  it('renders warning when include_password is on and password is not set', () => {
    const warningProfile: Profile = {
      ...baseProfile,
      include_password: true,
      password: { set: false, set_at: null, set_by: null },
    }

    render(<DeploymentDownloadCard profile={warningProfile} />, {
      wrapper: createDownloadWrapper(),
    })
    expect(
      screen.getByText(
        'No fleet password is set: the script removes the permanent password from every device it runs on.',
      ),
    ).toBeDefined()
  })

  it('shows the unlock PIN removal warning only when included and unset', () => {
    const warningProfile: Profile = {
      ...baseProfile,
      include_unlock_pin: true,
    }

    const { rerender } = render(<DeploymentDownloadCard profile={warningProfile} />, {
      wrapper: createDownloadWrapper(),
    })
    const warning =
      'No unlock PIN is set: the script removes the settings unlock PIN from every device it runs on.'
    expect(screen.getByText(warning)).toBeDefined()

    rerender(<DeploymentDownloadCard profile={{ ...warningProfile, include_unlock_pin: false }} />)
    expect(screen.queryByText(warning)).toBeNull()

    rerender(
      <DeploymentDownloadCard
        profile={{
          ...warningProfile,
          unlock_pin: {
            set: true,
            set_at: '2026-10-16T12:00:00Z',
            set_by: { id: 'admin-id', display_name: 'admin' },
          },
        }}
      />,
    )
    expect(screen.queryByText(warning)).toBeNull()
  })

  it('summarizes install, configuration, selected settings, and secret outcomes', () => {
    const settings = {
      'enable-lan-discovery': { include: true, value: 'Y' },
      'approve-mode': { include: true, value: 'password' },
      'direct-server': { include: true, value: 'Y' },
      'windows-feature': { include: false, value: 'N' },
    }
    const { rerender } = render(
      <DeploymentDownloadCard profile={{ ...baseProfile, allow_downgrade: true, settings }} />,
      { wrapper: createDownloadWrapper() },
    )
    expect(
      screen.getByText(
        'Installs RustDesk 1.5.0 or updates an older version or replaces a newer one (from GitHub)',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Connects RustDesk to this server: ID server, relay server, public key and API server (the client configuration on the Settings page)',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText("Applies 3 client settings (those that apply to the device's system)"),
    ).toBeInTheDocument()
    expect(screen.getByText("Leaves the device's password unchanged")).toBeInTheDocument()
    expect(screen.getByText('Leaves the settings unlock PIN unchanged')).toBeInTheDocument()

    rerender(
      <DeploymentDownloadCard
        profile={{
          ...baseProfile,
          settings: { 'enable-lan-discovery': { include: true, value: 'Y' } },
        }}
      />,
    )
    expect(
      screen.getByText('Installs RustDesk 1.5.0 or updates an older version (from GitHub)'),
    ).toBeInTheDocument()
    expect(
      screen.getByText("Applies 1 client setting (those that apply to the device's system)"),
    ).toBeInTheDocument()

    rerender(
      <DeploymentDownloadCard
        profile={{ ...baseProfile, installer_source: 'url', settings: {} }}
      />,
    )
    expect(
      screen.getByText(
        'Installs RustDesk 1.5.0 or updates an older version (from your download URLs)',
      ),
    ).toBeInTheDocument()

    rerender(
      <DeploymentDownloadCard
        profile={{
          ...baseProfile,
          installer_source: 'url',
          include_install: false,
          allow_downgrade: false,
          settings: {},
        }}
      />,
    )
    expect(
      screen.getByText('Leaves RustDesk as installed (it must already be installed)'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Applies \d+ client settings?/)).toBeNull()
    expect(screen.queryByText(/from your download URLs/)).toBeNull()
  })

  it('describes included secrets and names only those actually present in the script', () => {
    const passwordSet = { set: true, set_at: null, set_by: null }
    const pinSet = { set: true, set_at: null, set_by: null }
    const cases = [
      {
        profile: {
          ...baseProfile,
          include_password: true,
          password: passwordSet,
          include_unlock_pin: true,
          unlock_pin: pinSet,
        },
        text: 'The file contains the fleet password and the unlock PIN: store it like a secret. Run it elevated (Administrator/SYSTEM, root).',
      },
      {
        profile: { ...baseProfile, include_password: true, password: passwordSet },
        text: 'The file contains the fleet password: store it like a secret. Run it elevated (Administrator/SYSTEM, root).',
      },
      {
        profile: { ...baseProfile, include_unlock_pin: true, unlock_pin: pinSet },
        text: 'The file contains the unlock PIN: store it like a secret. Run it elevated (Administrator/SYSTEM, root).',
      },
      { profile: baseProfile, text: 'Run it elevated (Administrator/SYSTEM, root).' },
    ]
    for (const { profile, text } of cases) {
      const { unmount } = render(<DeploymentDownloadCard profile={profile} />, {
        wrapper: createDownloadWrapper(),
      })
      expect(screen.getByText(text)).toBeInTheDocument()
      unmount()
    }
  })

  it('describes password and PIN set, removed, and unchanged states', () => {
    const configured = {
      ...baseProfile,
      include_password: true,
      password: { set: true, set_at: null, set_by: null },
      include_unlock_pin: true,
      unlock_pin: { set: true, set_at: null, set_by: null },
    }
    const { rerender } = render(<DeploymentDownloadCard profile={configured} />, {
      wrapper: createDownloadWrapper(),
    })
    expect(screen.getByText('Sets the fleet password')).toBeInTheDocument()
    expect(screen.getByText('Sets the settings unlock PIN')).toBeInTheDocument()
    rerender(
      <DeploymentDownloadCard
        profile={{
          ...configured,
          password: { set: false, set_at: null, set_by: null },
          unlock_pin: { set: false, set_at: null, set_by: null },
        }}
      />,
    )
    expect(screen.getByText("Removes the device's permanent password")).toBeInTheDocument()
    expect(screen.getByText('Removes the settings unlock PIN')).toBeInTheDocument()
  })
})

describe('DeploymentDownloadCard policy push note', () => {
  it('renders policy push override note when policy push is enabled', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/policy-push') {
        return Promise.resolve({ data: { enabled: true } })
      }
      return Promise.resolve({ data: baseProfile })
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <DeploymentDownloadCard profile={baseProfile} />
        </ToasterProvider>
      </QueryClientProvider>,
    )
    expect(
      await screen.findByText(
        "Settings managed by a policy override this script's values within about 15 seconds.",
      ),
    ).toBeInTheDocument()
  })

  it('does not render policy push override note when policy push is disabled', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/policy-push') {
        return Promise.resolve({ data: { enabled: false } })
      }
      return Promise.resolve({ data: baseProfile })
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <DeploymentDownloadCard profile={baseProfile} />
        </ToasterProvider>
      </QueryClientProvider>,
    )
    await screen.findByText('Download deployment scripts')
    expect(
      screen.queryByText(
        "Settings managed by a policy override this script's values within about 15 seconds.",
      ),
    ).toBeNull()
  })
})

describe('DeploymentSettingsView download profile', () => {
  it('clears pinned checksums from the save body when switching to latest', async () => {
    const pinned = {
      ...baseProfile,
      sha256_windows: 'a'.repeat(64),
      sha256_deb: 'b'.repeat(64),
      sha256_rpm: 'c'.repeat(64),
    }
    apiMock.GET.mockResolvedValue({ data: pinned })
    apiMock.PUT.mockResolvedValue({
      data: {
        ...pinned,
        client_version: 'latest',
        sha256_windows: '',
        sha256_deb: '',
        sha256_rpm: '',
      },
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <DeploymentSettingsView />
        </ToasterProvider>
      </QueryClientProvider>,
    )
    await screen.findByLabelText('Specific version')
    fireEvent.click(screen.getByRole('combobox', { name: 'Client version' }))
    fireEvent.click(screen.getByRole('option', { name: 'Latest release' }))
    expect(screen.queryByLabelText('Windows SHA-256')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(apiMock.PUT).toHaveBeenCalledWith(
        '/admin/api/v1/deployment/profile',
        expect.objectContaining({
          body: expect.objectContaining({
            client_version: 'latest',
            sha256_windows: '',
            sha256_deb: '',
            sha256_rpm: '',
          }),
        }),
      ),
    )
  })
  it('saves latest as the client_version value', async () => {
    apiMock.GET.mockResolvedValue({ data: { ...baseProfile, client_version: 'latest' } })
    apiMock.PUT.mockResolvedValue({ data: { ...baseProfile, client_version: 'latest' } })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <DeploymentSettingsView />
        </ToasterProvider>
      </QueryClientProvider>,
    )
    await screen.findByText('Each script asks GitHub for the newest RustDesk release when it runs.')
    fireEvent.click(screen.getByRole('switch', { name: 'Allow downgrade' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(apiMock.PUT).toHaveBeenCalledWith(
        '/admin/api/v1/deployment/profile',
        expect.objectContaining({ body: expect.objectContaining({ client_version: 'latest' }) }),
      ),
    )
  })
  it('uses the saved profile for the card and disables downloads while edits are unsaved', async () => {
    apiMock.GET.mockResolvedValue({ data: baseProfile })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <DeploymentSettingsView />
        </ToasterProvider>
      </QueryClientProvider>,
    )
    const download = await screen.findByRole('button', { name: 'Windows (.ps1)' })
    expect(screen.getByText("Leaves the device's password unchanged")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Include fleet password in script' }))
    expect(
      screen.getByText(
        'You have unsaved changes. Save them first: the script is built from the saved settings.',
      ),
    ).toBeInTheDocument()
    expect(download).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Linux (.sh)' })).toBeDisabled()
    expect(screen.getByText("Leaves the device's password unchanged")).toBeInTheDocument()
  })
})

describe('DeploymentSettingsView ID allow list', () => {
  it('toggles switch, marks form unsaved, shows warning only when on, and sends include_id_allow_list: true in PUT', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/id-allow-list') {
        return Promise.resolve({ data: { ids: ['111222333'] } })
      }
      return Promise.resolve({ data: baseProfile })
    })
    apiMock.PUT.mockResolvedValue({
      data: { ...baseProfile, include_id_allow_list: true },
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <DeploymentSettingsView />
        </ToasterProvider>
      </QueryClientProvider>,
    )

    const toggle = await screen.findByRole('switch', {
      name: 'Include the Global ID Allowlist',
    })
    expect(toggle).not.toBeChecked()
    expect(toggle).toHaveAttribute('aria-describedby', 'include-id-allow-list-description')
    expect(
      screen.queryByText(
        /New devices will refuse every RustDesk ID not on the Global ID Allowlist until they are approved with policy push on\. Add your technicians' IDs first\./,
      ),
    ).toBeNull()

    fireEvent.click(toggle)

    expect(toggle).toBeChecked()
    expect(toggle).toHaveAttribute(
      'aria-describedby',
      'include-id-allow-list-description include-id-allow-list-warning',
    )
    expect(
      screen.getByText(
        'You have unsaved changes. Save them first: the script is built from the saved settings.',
      ),
    ).toBeInTheDocument()
    const warningText = screen.getByText(
      /New devices will refuse every RustDesk ID not on the Global ID Allowlist until they are approved with policy push on\. Add your technicians' IDs first\./,
    )
    expect(warningText).toBeInTheDocument()
    const warning = warningText.closest('[data-slot="id-allow-list-warning"]')
    expect(warning).toHaveAttribute('id', 'include-id-allow-list-warning')
    expect(warning).not.toHaveAttribute('role')
    expect(warning).not.toHaveAttribute('aria-live')
    expect(
      screen.queryByText(/The Global ID Allowlist is empty, so the script sets nothing\./),
    ).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(apiMock.PUT).toHaveBeenCalledWith(
        '/admin/api/v1/deployment/profile',
        expect.objectContaining({
          body: expect.objectContaining({ include_id_allow_list: true }),
        }),
      ),
    )
  })

  it('shows empty-list line when global list is empty and switch is on', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/id-allow-list') {
        return Promise.resolve({ data: { ids: [] } })
      }
      return Promise.resolve({ data: { ...baseProfile, include_id_allow_list: true } })
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <DeploymentSettingsView />
        </ToasterProvider>
      </QueryClientProvider>,
    )

    expect(
      await screen.findByText(/The Global ID Allowlist is empty, so the script sets nothing\./),
    ).toBeInTheDocument()
  })

  it('disables the ID allow list switch for admin', async () => {
    sessionMock.useMe.mockReturnValue({ data: { user: { role: 'admin' } } })
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/id-allow-list') {
        return Promise.resolve({ data: { ids: ['111222333'] } })
      }
      return Promise.resolve({ data: baseProfile })
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <DeploymentSettingsView />
        </ToasterProvider>
      </QueryClientProvider>,
    )

    const toggle = await screen.findByRole('switch', {
      name: 'Include the Global ID Allowlist',
    })
    expect(toggle).toBeDisabled()
  })

  it('renders cards in order: Installer, Client settings, Secrets and security, Save changes, Download', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/id-allow-list') {
        return Promise.resolve({ data: { ids: ['111222333'] } })
      }
      return Promise.resolve({ data: baseProfile })
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <DeploymentSettingsView />
        </ToasterProvider>
      </QueryClientProvider>,
    )

    const installer = await screen.findByText('Installer')
    const clientSettings = screen.getByText('Client settings')
    const secrets = screen.getByText('Secrets and security')
    const saveButton = screen.getByRole('button', { name: 'Save changes' })
    const download = screen.getByText('Download deployment scripts')

    const precedes = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

    expect(precedes(installer, clientSettings)).toBe(true)
    expect(precedes(clientSettings, secrets)).toBe(true)
    expect(precedes(secrets, saveButton)).toBe(true)
    expect(precedes(saveButton, download)).toBe(true)
  })

  it('saving the password or PIN in its dialog does not submit the profile form', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/id-allow-list') {
        return Promise.resolve({ data: { ids: ['111222333'] } })
      }
      return Promise.resolve({ data: baseProfile })
    })
    apiMock.PUT.mockClear()
    apiMock.PUT.mockImplementation(
      async (_path: string, opts?: { body?: Record<string, unknown> }) => ({
        data: {
          ...baseProfile,
          password: opts?.body?.fleet_password
            ? {
                set: true,
                set_at: '2026-11-13T12:00:00Z',
                set_by: { id: '1', display_name: 'owner' },
              }
            : baseProfile.password,
          unlock_pin: opts?.body?.unlock_pin
            ? {
                set: true,
                set_at: '2026-11-13T12:00:00Z',
                set_by: { id: '1', display_name: 'owner' },
              }
            : baseProfile.unlock_pin,
        },
      }),
    )

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <DeploymentSettingsView />
        </ToasterProvider>
      </QueryClientProvider>,
    )

    // Make an unsaved edit to the profile form
    const allowListToggle = await screen.findByRole('switch', {
      name: 'Include the Global ID Allowlist',
    })
    fireEvent.click(allowListToggle)
    expect(allowListToggle).toBeChecked()

    // Open password dialog and save
    fireEvent.click(screen.getByRole('button', { name: 'Set fleet password' }))
    const pwdInput = await screen.findByLabelText('Fleet password')
    const confirmInput = screen.getByLabelText('Confirm password')
    fireEvent.change(pwdInput, { target: { value: 'ValidPass123' } })
    fireEvent.change(confirmInput, { target: { value: 'ValidPass123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save password' }))

    await waitFor(() => expect(apiMock.PUT).toHaveBeenCalledTimes(1))
    expect(apiMock.PUT).toHaveBeenCalledWith(
      '/admin/api/v1/deployment/profile',
      expect.objectContaining({
        body: expect.objectContaining({
          fleet_password: 'ValidPass123',
          include_id_allow_list: false,
        }),
      }),
    )
    // Unsaved edit in profile form is still preserved
    expect(allowListToggle).toBeChecked()

    // Open PIN dialog and save
    fireEvent.click(screen.getByRole('button', { name: 'Set unlock PIN' }))
    const pinInput = await screen.findByLabelText('Unlock PIN')
    const pinConfirm = screen.getByLabelText('Confirm PIN')
    fireEvent.change(pinInput, { target: { value: '4321' } })
    fireEvent.change(pinConfirm, { target: { value: '4321' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save PIN' }))

    await waitFor(() => expect(apiMock.PUT).toHaveBeenCalledTimes(2))
    expect(apiMock.PUT).toHaveBeenLastCalledWith(
      '/admin/api/v1/deployment/profile',
      expect.objectContaining({
        body: expect.objectContaining({
          unlock_pin: '4321',
          include_id_allow_list: false,
        }),
      }),
    )
    // Unsaved edit in profile form is still preserved
    expect(allowListToggle).toBeChecked()
  })

  it('submits the profile once from an input inside the form via external submit button association', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/id-allow-list') {
        return Promise.resolve({ data: { ids: ['111222333'] } })
      }
      return Promise.resolve({ data: baseProfile })
    })
    apiMock.PUT.mockClear()
    apiMock.PUT.mockResolvedValue({ data: { ...baseProfile, client_version: '1.5.1' } })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToasterProvider>
          <DeploymentSettingsView />
        </ToasterProvider>
      </QueryClientProvider>,
    )

    const versionInput = await screen.findByLabelText('Specific version')

    fireEvent.change(versionInput, { target: { value: '1.5.1' } })

    const form = versionInput.closest('form')
    expect(form).not.toBeNull()
    expect(form?.id).toBeTruthy()
    const saveButton = screen.getByRole('button', { name: 'Save changes' })
    expect(saveButton).toHaveAttribute('form', form!.id)

    fireEvent.submit(form!)
    await waitFor(() => expect(apiMock.PUT).toHaveBeenCalledTimes(1))
    expect(apiMock.PUT).toHaveBeenCalledWith(
      '/admin/api/v1/deployment/profile',
      expect.objectContaining({
        body: expect.objectContaining({ client_version: '1.5.1' }),
      }),
    )
  })
})
