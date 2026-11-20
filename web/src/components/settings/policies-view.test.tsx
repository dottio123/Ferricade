import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { components } from '@/api/schema'
import { ApiError, type ApiErrorCode } from '@/api/errors'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PoliciesView } from './policies-view'

type Policy = components['schemas']['Policy']
type PolicyPush = components['schemas']['PolicyPush']
type DeploymentProfile = components['schemas']['DeploymentProfile']

const apiMock = vi.hoisted(() => ({
  GET: vi.fn(),
  POST: vi.fn(),
  PUT: vi.fn(),
  PATCH: vi.fn(),
  DELETE: vi.fn(),
}))

const sessionMock = vi.hoisted(() => ({
  useMe: vi.fn(),
}))

const routerMock = vi.hoisted(() => {
  let searchState = {} as Record<string, unknown>
  const listeners = new Set<() => void>()
  return {
    navigate: vi.fn(
      (opts: { to?: string; search?: Record<string, unknown>; replace?: boolean }) => {
        searchState = opts?.search ?? {}
        listeners.forEach((l) => l())
      },
    ),
    getSearch: () => searchState,
    setSearch: (s: Record<string, unknown>) => {
      searchState = s
    },
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
  }
})

const toastMock = vi.hoisted(() => ({
  toast: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string
    children: React.ReactNode
    [key: string]: unknown
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => routerMock.navigate,
  useSearch: () => {
    const [, forceUpdate] = React.useState({})
    React.useEffect(() => routerMock.subscribe(() => forceUpdate({})), [])
    return routerMock.getSearch()
  },
}))

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ toast: toastMock.toast }),
}))

vi.mock('@/api/client', () => ({
  api: apiMock,
  unwrap: async (promise: Promise<{ data?: unknown; error?: unknown }>) => {
    const res = await promise
    if (res.error) {
      const err = res.error as { code?: string; message?: string }
      throw new ApiError(400, (err.code ?? 'unknown') as ApiErrorCode, err.message ?? 'error')
    }
    return res.data
  },
}))

Element.prototype.scrollIntoView = vi.fn()

vi.mock('@/auth/session', () => ({
  useMe: () => sessionMock.useMe(),
}))

vi.mock('@/components/page-header', () => ({
  PageHeader: ({
    title,
    description,
    actions,
    backLink,
  }: {
    title: string
    description?: string
    actions?: React.ReactNode
    backLink?: { to: string; label: string }
  }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      {backLink && (
        <a href={backLink.to} data-testid="back-link">
          {backLink.label}
        </a>
      )}
      {actions}
    </div>
  ),
}))

const defaultPolicy: Policy = {
  id: 'pol-default',
  name: 'Default',
  is_default: true,
  settings: {
    'approve-mode': 'password-click',
    'verification-method': 'use-both-passwords',
  },
  updated_at: '2026-10-18T10:00:00Z',
  updated_by: { id: 'u1', display_name: 'Alice Owner' },
}

const customPolicy: Policy = {
  id: 'pol-workstations',
  name: 'Workstations',
  is_default: false,
  settings: {
    'approve-mode': 'password',
    'verification-method': 'use-permanent-password',
    'enable-file-transfer': 'N',
  },
  updated_at: '2026-10-18T12:00:00Z',
  updated_by: { id: 'u2', display_name: 'Bob Admin' },
}

const mockProfile: DeploymentProfile = {
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
      default: 'password-click',
      os: ['windows', 'linux', 'macos'],
      source: 'libs/hbb_common/src/password_security.rs:77',
    },
    {
      key: 'verification-method',
      label: 'Which passwords work',
      help: 'Which password a connecting person may use: the temporary one RustDesk shows on the device, the fleet password set by this script, or either.',
      type: 'enum',
      values: ['use-temporary-password', 'use-permanent-password', 'use-both-passwords'],
      value_labels: {
        'use-temporary-password': 'Temporary password only',
        'use-both-passwords': 'Either password',
        'use-permanent-password': 'Permanent (fleet) password only',
      },
      default: 'use-both-passwords',
      os: ['windows', 'linux', 'macos'],
      source: 'libs/hbb_common/src/password_security.rs:42',
    },
    {
      key: 'enable-file-transfer',
      label: 'File transfer',
      help: 'Send and receive files during a session. RustDesk default: on.',
      type: 'bool',
      values: ['Y', 'N'],
      value_labels: { Y: 'On', N: 'Off' },
      default: 'Y',
      os: ['windows', 'linux', 'macos'],
      source: 'libs/base/src/config/keys.rs:40',
    },
    {
      key: 'enable-clipboard',
      label: 'Clipboard sharing',
      help: 'Copy and paste between the two devices during a session. RustDesk default: on.',
      type: 'bool',
      values: ['Y', 'N'],
      value_labels: { Y: 'On', N: 'Off' },
      default: 'Y',
      os: ['windows', 'linux', 'macos'],
      source: 'libs/base/src/config/keys.rs:39',
    },
  ],
  password: { set: false, set_at: null, set_by: null },
  unlock_pin: { set: false, set_at: null, set_by: null },
  updated_at: null,
}

const mockPushOff: PolicyPush = {
  enabled: false,
  updated_at: '2026-10-17T08:00:00Z',
  updated_by: { id: 'u1', display_name: 'Alice Owner' },
}

const mockPushNever: PolicyPush = {
  enabled: false,
  updated_at: null as unknown as string,
  updated_by: null,
}

function renderPoliciesView(queryClient?: QueryClient) {
  const client =
    queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PoliciesView />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

async function pick(trigger: HTMLElement, name: string | RegExp) {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const option = await screen.findByRole('option', {
    name: typeof name === 'string' ? new RegExp(`^${name}`, 'i') : name,
  })
  fireEvent.click(option)
}

describe('PoliciesView', () => {
  it('explains the permission preset in the policy editor', async () => {
    renderPoliciesView()
    fireEvent.click(await screen.findByRole('button', { name: /new policy|create policy/i }))
    expect(
      await screen.findByText(
        "Managing a permission also sets the device's permission preset to Custom, otherwise Full access would override it.",
      ),
    ).toBeInTheDocument()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    routerMock.setSearch({})
    routerMock.navigate.mockReset()
    toastMock.toast.mockReset()
    sessionMock.useMe.mockReturnValue({
      data: { user: { id: 'u1', role: 'owner', username: 'owner' } },
    })

    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/policy-push') {
        return Promise.resolve({ data: mockPushOff })
      }
      if (path === '/admin/api/v1/policies') {
        return Promise.resolve({ data: { items: [defaultPolicy, customPolicy] } })
      }
      if (path === '/admin/api/v1/deployment/profile') {
        return Promise.resolve({ data: mockProfile })
      }
      if (path === '/admin/api/v1/settings/id-allow-list') {
        return Promise.resolve({ data: { ids: ['111222333', '444555666'] } })
      }
      return Promise.reject(new Error(`unknown path: ${path}`))
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('opens the editor from ?edit=<id> and navigates to /policies on Back and Cancel', async () => {
    routerMock.setSearch({ edit: 'pol-workstations' })
    renderPoliciesView()

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Edit Workstations' }),
    ).toBeInTheDocument()
    const backLink = screen.getByTestId('back-link')
    expect(backLink).toHaveAttribute('href', '/policies')

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(routerMock.navigate).toHaveBeenCalledWith({ to: '/policies' })
  })

  it('opens the editor for new policy when ?edit=new', async () => {
    routerMock.setSearch({ edit: 'new' })
    renderPoliciesView()

    expect(
      await screen.findByRole('heading', { level: 1, name: 'New Client Policy' }),
    ).toBeInTheDocument()
    const backLink = screen.getByTestId('back-link')
    expect(backLink).toHaveAttribute('href', '/policies')
  })

  it('shows toast and navigates to /policies when ?edit is an unknown id', async () => {
    routerMock.setSearch({ edit: 'pol-unknown' })
    renderPoliciesView()

    await waitFor(() => {
      expect(toastMock.toast).toHaveBeenCalledWith({
        title: 'Policy not found',
        variant: 'destructive',
      })
      expect(routerMock.navigate).toHaveBeenCalledWith({ to: '/policies', replace: true })
    })
  })

  it('renders the policy list with Default first, Default badge, managed count and last updated', async () => {
    renderPoliciesView()

    expect(await screen.findByText('Workstations')).toBeInTheDocument()

    // Default policy name and Default badge
    const defaultElements = screen.getAllByText('Default')
    expect(defaultElements.length).toBeGreaterThanOrEqual(2)

    // Managed settings count
    expect(screen.getByText(/2 settings managed|2 managed/i)).toBeInTheDocument()
    expect(screen.getByText(/3 settings managed|3 managed/i)).toBeInTheDocument()

    // Default policy has no delete button
    expect(screen.queryByRole('button', { name: /delete default/i })).not.toBeInTheDocument()
    // Custom policy has delete button
    expect(screen.getByRole('button', { name: /delete workstations/i })).toBeInTheDocument()
  })

  it('shows push switch with last updated by and relative time, or never when null', async () => {
    renderPoliciesView()

    expect(await screen.findByRole('switch', { name: /policy push/i })).toBeInTheDocument()
    const switchCard = screen
      .getByRole('switch', { name: /policy push/i })
      .closest('[data-slot="card"]')
    expect(switchCard).toHaveTextContent(/Alice Owner/)
  })

  it('displays "never" when policy push has never been updated', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/policy-push') {
        return Promise.resolve({ data: mockPushNever })
      }
      if (path === '/admin/api/v1/policies') {
        return Promise.resolve({ data: { items: [defaultPolicy] } })
      }
      if (path === '/admin/api/v1/deployment/profile') {
        return Promise.resolve({ data: mockProfile })
      }
      if (path === '/admin/api/v1/settings/id-allow-list') {
        return Promise.resolve({ data: { ids: ['111222333', '444555666'] } })
      }
      return Promise.reject(new Error(`unknown path: ${path}`))
    })

    renderPoliciesView()
    expect(await screen.findByText(/never/i)).toBeInTheDocument()
  })

  it('allows owner to toggle push on with exact confirmation copy', async () => {
    apiMock.PUT.mockImplementation((path: string, options: { body: { enabled: boolean } }) => {
      if (path === '/admin/api/v1/settings/policy-push') {
        return Promise.resolve({
          data: {
            enabled: options.body.enabled,
            updated_at: '2026-10-19T10:00:00Z',
            updated_by: { id: 'u1', username: 'owner', display_name: 'Alice Owner' },
          },
        })
      }
      return Promise.reject(new Error(`unknown path: ${path}`))
    })

    renderPoliciesView()

    const pushSwitch = await screen.findByRole('switch', { name: /policy push/i })
    fireEvent.click(pushSwitch)

    // Confirmation dialog
    expect(await screen.findByText('Turn on policy push?')).toBeInTheDocument()
    expect(
      screen.getByText(
        /Approved devices apply their policy's settings within about 15 seconds\. Managed settings override values set on the device or by a deployment script\./,
      ),
    ).toBeInTheDocument()

    // Confirm turn on
    const confirmButton = screen.getByRole('button', { name: /turn on|confirm/i })
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(apiMock.PUT).toHaveBeenCalledWith('/admin/api/v1/settings/policy-push', {
        body: { enabled: true },
      })
    })
  })

  it('allows owner to toggle push off with exact confirmation copy', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/policy-push') {
        return Promise.resolve({ data: { ...mockPushOff, enabled: true } })
      }
      if (path === '/admin/api/v1/policies') {
        return Promise.resolve({ data: { items: [defaultPolicy] } })
      }
      if (path === '/admin/api/v1/deployment/profile') {
        return Promise.resolve({ data: mockProfile })
      }
      if (path === '/admin/api/v1/settings/id-allow-list') {
        return Promise.resolve({ data: { ids: ['111222333', '444555666'] } })
      }
      return Promise.reject(new Error(`unknown path: ${path}`))
    })

    apiMock.PUT.mockResolvedValue({
      data: { ...mockPushOff, enabled: false },
    })

    renderPoliciesView()

    const pushSwitch = await screen.findByRole('switch', { name: /policy push/i })
    fireEvent.click(pushSwitch)

    expect(await screen.findByText('Turn off policy push?')).toBeInTheDocument()
    expect(
      screen.getByText(
        /Devices keep the settings they last received\. Ferricade stops managing them until you turn this on again\./,
      ),
    ).toBeInTheDocument()

    const confirmButton = screen.getByRole('button', { name: /turn off|confirm/i })
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(apiMock.PUT).toHaveBeenCalledWith('/admin/api/v1/settings/policy-push', {
        body: { enabled: false },
      })
    })
  })

  it('handles push-off 409 window_open error and keeps switch on', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/policy-push') {
        return Promise.resolve({ data: { ...mockPushOff, enabled: true } })
      }
      if (path === '/admin/api/v1/policies') {
        return Promise.resolve({ data: { items: [defaultPolicy] } })
      }
      if (path === '/admin/api/v1/deployment/profile') {
        return Promise.resolve({ data: mockProfile })
      }
      if (path === '/admin/api/v1/settings/id-allow-list') {
        return Promise.resolve({ data: { ids: ['111222333', '444555666'] } })
      }
      return Promise.reject(new Error(`unknown path: ${path}`))
    })

    apiMock.PUT.mockResolvedValue({
      error: { code: 'window_open', message: 'close the open access windows first' },
    })

    renderPoliciesView()

    const pushSwitch = await screen.findByRole('switch', { name: /policy push/i })
    fireEvent.click(pushSwitch)

    const confirmButton = await screen.findByRole('button', { name: /turn off|confirm/i })
    fireEvent.click(confirmButton)

    expect(await screen.findByText(/close the open access windows first/i)).toBeInTheDocument()
    // Switch stays on
    expect(pushSwitch).toBeChecked()
  })

  it('renders push switch read-only for admin with note "Only the owner can change this."', async () => {
    sessionMock.useMe.mockReturnValue({
      data: { user: { id: 'u2', role: 'admin', username: 'admin' } },
    })

    renderPoliciesView()

    const pushSwitch = await screen.findByRole('switch', { name: /policy push/i })
    expect(pushSwitch).toBeDisabled()
    expect(screen.getByText('Only the owner can change this.')).toBeInTheDocument()
  })

  it('handles policy delete with 409 in_use exact message', async () => {
    apiMock.DELETE.mockResolvedValue({
      error: {
        code: 'in_use',
        message: 'This policy is used by a group. Choose another policy for those groups first.',
      },
    })

    renderPoliciesView()

    const deleteBtn = await screen.findByRole('button', { name: /delete workstations/i })
    fireEvent.click(deleteBtn)

    const confirmDelete = await screen.findByRole('button', {
      name: /confirm delete|delete policy/i,
    })
    fireEvent.click(confirmDelete)

    expect(
      await screen.findByText(
        'This policy is used by a group. Choose another policy for those groups first.',
      ),
    ).toBeInTheDocument()
  })

  it('handles policy create with 409 name_taken exact message', async () => {
    apiMock.POST.mockResolvedValue({
      error: {
        code: 'name_taken',
        message: 'A policy with this name already exists.',
      },
    })

    renderPoliciesView()

    const newBtn = await screen.findByRole('button', { name: /new policy|create policy/i })
    fireEvent.click(newBtn)

    const nameInput = await screen.findByLabelText(/policy name/i)
    fireEvent.change(nameInput, { target: { value: 'Workstations' } })

    const saveBtn = screen.getByRole('button', { name: /save|create/i })
    fireEvent.click(saveBtn)

    expect(await screen.findByText('A policy with this name already exists.')).toBeInTheDocument()
  })

  it('edits a policy: "Not managed" removes key from PATCH body, baseline always sent', async () => {
    apiMock.PATCH.mockResolvedValue({
      data: {
        ...customPolicy,
        settings: {
          'approve-mode': 'password',
          'verification-method': 'use-permanent-password',
        },
      },
    })

    renderPoliciesView()

    const editBtn = await screen.findByRole('button', { name: /edit workstations/i })
    fireEvent.click(editBtn)

    // Baseline settings are visible and required (no Not managed)
    expect(
      await screen.findByRole('combobox', { name: /how incoming connections are accepted/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /which passwords work/i })).toBeInTheDocument()

    // File transfer is currently 'N'. Set it to "Not managed"
    const fileTransferTrigger = screen.getByRole('combobox', { name: /file transfer/i })
    await pick(fileTransferTrigger, 'Not managed')

    const saveBtn = screen.getByRole('button', { name: /save/i })
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(apiMock.PATCH).toHaveBeenCalledWith(
        '/admin/api/v1/policies/{id}',
        expect.objectContaining({
          params: { path: { id: 'pol-workstations' } },
          body: expect.objectContaining({
            settings: {
              'approve-mode': 'password',
              'verification-method': 'use-permanent-password',
            },
          }),
        }),
      )
    })
  })

  it('lockout confirmation appears only for non-always-reachable baseline', async () => {
    apiMock.PATCH.mockResolvedValue({
      data: customPolicy,
    })

    renderPoliciesView()

    const editBtn = await screen.findByRole('button', { name: /edit workstations/i })
    fireEvent.click(editBtn)

    // Change approve-mode to click (not password / password-click)
    const approveModeTrigger = await screen.findByRole('combobox', {
      name: /how incoming connections are accepted/i,
    })
    await pick(approveModeTrigger, 'Click to accept only')

    const saveBtn = screen.getByRole('button', { name: /save/i })
    fireEvent.click(saveBtn)

    // Lockout confirmation dialog must appear with exact copy
    expect(
      await screen.findByText(
        'Devices using this policy can only be reached through an access window or by someone at the device.',
      ),
    ).toBeInTheDocument()

    // Cancel does not call PATCH
    const cancelBtn = screen.getByRole('button', { name: /cancel/i })
    fireEvent.click(cancelBtn)
    expect(apiMock.PATCH).not.toHaveBeenCalled()

    // Click Save again, then Save anyway
    fireEvent.click(saveBtn)
    const saveAnywayBtn = await screen.findByRole('button', { name: /save anyway/i })
    fireEvent.click(saveAnywayBtn)

    await waitFor(() => {
      expect(apiMock.PATCH).toHaveBeenCalled()
    })
  })

  it('lockout confirmation footer keeps the shared gap at every width (no sm gap override)', async () => {
    renderPoliciesView()

    fireEvent.click(await screen.findByRole('button', { name: /edit workstations/i }))
    const approveModeTrigger = await screen.findByRole('combobox', {
      name: /how incoming connections are accepted/i,
    })
    await pick(approveModeTrigger, 'Click to accept only')
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    const dialog = await screen.findByRole('dialog', { name: /confirm access baseline/i })
    const footer = dialog.querySelector('[data-slot="dialog-footer"]')
    expect(footer).not.toBeNull()
    expect(footer?.classList.contains('gap-2')).toBe(true)
    // A breakpoint gap class would override the shared gap-2 from sm up (t136).
    expect([...(footer?.classList ?? [])].filter((c) => c.startsWith('sm:gap-'))).toEqual([])
  })

  it('shows ID allow list notice with count and link for owner/admin', async () => {
    renderPoliciesView()

    expect(
      await screen.findByText(
        /ID allow lists are sent with policies while push is on\. Global ID Allowlist: 2 IDs\. Group and device lists add to it\./,
      ),
    ).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Edit the Global ID Allowlist' })
    expect(link).toHaveAttribute('href', '/settings/id-allow-list')
  })

  it('shows empty-list wording when global ID allow list is empty', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/policy-push') {
        return Promise.resolve({ data: mockPushOff })
      }
      if (path === '/admin/api/v1/policies') {
        return Promise.resolve({ data: { items: [defaultPolicy] } })
      }
      if (path === '/admin/api/v1/deployment/profile') {
        return Promise.resolve({ data: mockProfile })
      }
      if (path === '/admin/api/v1/settings/id-allow-list') {
        return Promise.resolve({ data: { ids: [] } })
      }
      return Promise.reject(new Error(`unknown path: ${path}`))
    })

    renderPoliciesView()

    expect(
      await screen.findByText(
        /ID allow lists are sent with policies while push is on\. Global ID Allowlist: empty \(any ID can connect\)\. Group and device lists add to it\./,
      ),
    ).toBeInTheDocument()
  })

  it('hides ID allow list notice on 403 error', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/settings/policy-push') {
        return Promise.resolve({ data: mockPushOff })
      }
      if (path === '/admin/api/v1/policies') {
        return Promise.resolve({ data: { items: [defaultPolicy] } })
      }
      if (path === '/admin/api/v1/deployment/profile') {
        return Promise.resolve({ data: mockProfile })
      }
      if (path === '/admin/api/v1/settings/id-allow-list') {
        return Promise.resolve({ error: { code: 'forbidden', message: 'forbidden' } })
      }
      return Promise.reject(new Error(`unknown path: ${path}`))
    })

    renderPoliciesView()

    await screen.findByRole('switch', { name: /policy push/i })
    await waitFor(() => {
      expect(
        screen.queryByText(/ID allow lists are sent with policies while push is on\./),
      ).toBeNull()
    })
  })

  it('hides ID allow list notice for role user and does not fetch it', async () => {
    sessionMock.useMe.mockReturnValue({
      data: { user: { id: 'u3', role: 'user', username: 'user' } },
    })

    renderPoliciesView()

    await screen.findByRole('switch', { name: /policy push/i })
    expect(
      screen.queryByText(/ID allow lists are sent with policies while push is on\./),
    ).toBeNull()
    expect(apiMock.GET).not.toHaveBeenCalledWith('/admin/api/v1/settings/id-allow-list')
  })

  it('shows no toast while pending or rejected, and exactly one after creating, editing, or toggling policy push', async () => {
    const deferred = <T,>() => {
      let resolve!: (v: T) => void
      let reject!: (e: unknown) => void
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    toastMock.toast.mockClear()
    const createFail = deferred<{ data?: unknown; error?: { code?: string; message?: string } }>()
    apiMock.POST.mockReturnValueOnce(createFail.promise)
    routerMock.setSearch({ edit: 'new' })
    renderPoliciesView()

    const nameInput = await screen.findByLabelText(/Policy name/i)
    fireEvent.change(nameInput, { target: { value: 'Kiosks' } })
    fireEvent.click(screen.getByRole('button', { name: /Create policy/i }))
    expect(toastMock.toast).not.toHaveBeenCalled()
    createFail.resolve({ error: { code: 'unknown', message: 'Create failed' } })
    expect(await screen.findByText('Create failed')).toBeInTheDocument()
    expect(toastMock.toast).not.toHaveBeenCalled()

    const createOk = deferred<{ data: Policy }>()
    apiMock.POST.mockReturnValueOnce(createOk.promise)
    fireEvent.click(screen.getByRole('button', { name: /Create policy/i }))
    await waitFor(() => expect(apiMock.POST).toHaveBeenCalledTimes(2))
    expect(toastMock.toast).not.toHaveBeenCalled()
    createOk.resolve({ data: { ...customPolicy, id: 'pol-new', name: 'Kiosks' } })
    await waitFor(() => expect(toastMock.toast).toHaveBeenCalledTimes(1))
    expect(toastMock.toast).toHaveBeenCalledWith({ title: 'Policy created' })
    cleanup()

    toastMock.toast.mockClear()
    const editFail = deferred<{ data?: unknown; error?: { code?: string; message?: string } }>()
    apiMock.PATCH.mockReturnValueOnce(editFail.promise)
    routerMock.setSearch({ edit: 'pol-workstations' })
    renderPoliciesView()

    const editName = await screen.findByLabelText(/Policy name/i)
    fireEvent.change(editName, { target: { value: 'Workstations v2' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }))
    expect(toastMock.toast).not.toHaveBeenCalled()
    editFail.resolve({ error: { code: 'unknown', message: 'Save failed' } })
    expect(await screen.findByText('Save failed')).toBeInTheDocument()
    expect(toastMock.toast).not.toHaveBeenCalled()

    const editOk = deferred<{ data: Policy }>()
    apiMock.PATCH.mockReturnValueOnce(editOk.promise)
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }))
    await waitFor(() => expect(apiMock.PATCH).toHaveBeenCalledTimes(2))
    expect(toastMock.toast).not.toHaveBeenCalled()
    editOk.resolve({ data: customPolicy })
    await waitFor(() => expect(toastMock.toast).toHaveBeenCalledTimes(1))
    expect(toastMock.toast).toHaveBeenCalledWith({ title: 'Policy saved' })
    cleanup()

    toastMock.toast.mockClear()
    const pushFail = deferred<{ data?: unknown; error?: { code?: string; message?: string } }>()
    apiMock.PUT.mockReturnValueOnce(pushFail.promise)
    routerMock.setSearch({})
    renderPoliciesView()

    const pushSwitch = await screen.findByRole('switch', { name: /policy push/i })
    fireEvent.click(pushSwitch)
    fireEvent.click(await screen.findByRole('button', { name: /turn on|confirm/i }))
    expect(toastMock.toast).not.toHaveBeenCalled()
    pushFail.resolve({ error: { code: 'unknown', message: 'Push failed' } })
    expect(await screen.findByText('Push failed')).toBeInTheDocument()
    expect(toastMock.toast).not.toHaveBeenCalled()

    const pushOk = deferred<{ data: PolicyPush }>()
    apiMock.PUT.mockReturnValueOnce(pushOk.promise)
    fireEvent.click(pushSwitch)
    fireEvent.click(await screen.findByRole('button', { name: /turn on|confirm/i }))
    await waitFor(() => expect(apiMock.PUT).toHaveBeenCalledTimes(2))
    expect(toastMock.toast).not.toHaveBeenCalled()
    pushOk.resolve({ data: { ...mockPushOff, enabled: true } })
    await waitFor(() => expect(toastMock.toast).toHaveBeenCalledTimes(1))
    expect(toastMock.toast).toHaveBeenCalledWith({ title: 'Policy push enabled' })
  })
})
