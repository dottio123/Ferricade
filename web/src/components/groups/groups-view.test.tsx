import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToasterProvider } from '@/components/ui/toast'
import type { components } from '@/api/schema'
import { GroupsView } from './groups-view'

type Group = components['schemas']['Group']
type Policy = components['schemas']['Policy']

const apiMock = vi.hoisted(() => ({
  GET: vi.fn(),
  POST: vi.fn(),
  PUT: vi.fn(),
  DELETE: vi.fn(),
}))

const sessionMock = vi.hoisted(() => ({
  useMe: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    search,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string
    search?: { group?: string }
  }) => (
    <a href={`${to}${search?.group ? `?group=${search.group}` : ''}`} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@/api/client', () => ({
  api: apiMock,
  unwrap: async (promise: Promise<{ data?: unknown; error?: unknown }>) => {
    const res = await promise
    if (res.error) throw res.error
    return res.data
  },
}))

vi.mock('@/auth/session', () => ({
  useMe: () => sessionMock.useMe(),
}))

vi.mock('@/components/page-header', () => ({
  PageHeader: ({
    title,
    description,
    actions,
  }: {
    title: string
    description?: string
    actions?: React.ReactNode
  }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      {actions && <div>{actions}</div>}
    </div>
  ),
}))

const defaultPolicy: Policy = {
  id: 'pol-default',
  name: 'Default',
  is_default: true,
  settings: { 'approve-mode': 'password-click', 'verification-method': 'use-both-passwords' },
  updated_at: '2026-10-18T10:00:00Z',
  updated_by: null,
}

const customPolicy: Policy = {
  id: 'pol-custom',
  name: 'Engineering Policy',
  is_default: false,
  settings: { 'approve-mode': 'password', 'verification-method': 'use-permanent-password' },
  updated_at: '2026-10-18T12:00:00Z',
  updated_by: null,
}

// 3-level group tree:
// Root (Corp) -> Sub (Engineering, policy_id: pol-custom) -> SubSub (Frontend, policy_id: null)
const threeLevelTree: Group[] = [
  {
    id: 'grp-root',
    name: 'Corp',
    parent_id: null,
    policy_id: null,
    effective_policy_id: 'pol-default',
    children: [
      {
        id: 'grp-sub',
        name: 'Engineering',
        parent_id: 'grp-root',
        policy_id: 'pol-custom',
        effective_policy_id: 'pol-custom',
        children: [
          {
            id: 'grp-subsub',
            name: 'Frontend',
            parent_id: 'grp-sub',
            policy_id: null,
            effective_policy_id: 'pol-custom',
            children: [],
          },
        ],
      },
    ],
  },
]

function renderGroupsView() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={client}>
      <ToasterProvider>
        <GroupsView />
      </ToasterProvider>
    </QueryClientProvider>,
  )
}

Element.prototype.scrollIntoView = vi.fn()

async function pick(trigger: HTMLElement, name: string | RegExp) {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const option = await screen.findByRole('option', {
    name: typeof name === 'string' ? new RegExp(`^${name}`, 'i') : name,
  })
  fireEvent.click(option)
}

describe('GroupsView policy picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionMock.useMe.mockReturnValue({
      data: { user: { id: 'u1', role: 'admin', username: 'admin' } },
    })

    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({ data: { items: threeLevelTree } })
      }
      if (path === '/admin/api/v1/stats/summary') {
        return Promise.resolve({ data: { groups: [] } })
      }
      if (path === '/admin/api/v1/policies') {
        return Promise.resolve({ data: { items: [defaultPolicy, customPolicy] } })
      }
      if (path === '/admin/api/v1/group-rules') {
        return Promise.resolve({ data: { items: [] } })
      }
      return Promise.reject(new Error(`unknown path: ${path}`))
    })

    apiMock.PUT.mockResolvedValue({
      data: { ...threeLevelTree[0] },
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders Inherited: <name> (from <group>) and Default labels on a 3-level tree', async () => {
    renderGroupsView()

    // Root group has policy_id: null and no ancestor policy -> shows "Default"
    expect(await screen.findByText('Corp')).toBeInTheDocument()
    expect(screen.getByText('Engineering')).toBeInTheDocument()
    expect(screen.getByText('Frontend')).toBeInTheDocument()

    // Labels:
    // Root group policy trigger or display shows "Default"
    const rootTrigger = screen.getByRole('combobox', { name: /policy for corp/i })
    expect(rootTrigger).toHaveTextContent('Default')

    // Engineering group has own policy -> shows "Engineering Policy"
    const subTrigger = screen.getByRole('combobox', { name: /policy for engineering/i })
    expect(subTrigger).toHaveTextContent('Engineering Policy')

    // Frontend group has policy_id: null and inherits from Engineering -> shows "Inherited: Engineering Policy (from Engineering)"
    const subSubTrigger = screen.getByRole('combobox', { name: /policy for frontend/i })
    expect(subSubTrigger).toHaveTextContent('Inherited: Engineering Policy (from Engineering)')
  })

  it('group picker sends null for Inherit', async () => {
    renderGroupsView()

    const subTrigger = await screen.findByRole('combobox', { name: /policy for engineering/i })
    await pick(subTrigger, 'Inherit')

    await waitFor(() => {
      expect(apiMock.PUT).toHaveBeenCalledWith('/admin/api/v1/groups/{id}/policy', {
        params: { path: { id: 'grp-sub' } },
        body: { policy_id: null },
      })
    })
  })

  it("a User's groups page renders no policy UI and requests no /policies", async () => {
    sessionMock.useMe.mockReturnValue({
      data: { user: { id: 'u3', role: 'user', username: 'user1' } },
    })

    renderGroupsView()

    expect(await screen.findByText('Corp')).toBeInTheDocument()

    // No policy UI
    expect(screen.queryByRole('button', { name: /policy for/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/Inherited:/i)).not.toBeInTheDocument()

    // And makes no /policies call
    const pathsCalled = apiMock.GET.mock.calls.map((call) => call[0])
    expect(pathsCalled).not.toContain('/admin/api/v1/policies')
    expect(pathsCalled).not.toContain('/admin/api/v1/group-rules')
  })

  it('owner sees Auto Sort All button, admin and User do not', async () => {
    // Admin check (set up in beforeEach)
    renderGroupsView()
    expect(await screen.findByText('Corp')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Auto Sort All' })).toBeNull()

    cleanup()

    // Owner check
    sessionMock.useMe.mockReturnValue({
      data: { user: { id: 'u0', role: 'owner', username: 'owner1' } },
    })
    renderGroupsView()
    expect(await screen.findByRole('button', { name: 'Auto Sort All' })).toBeInTheDocument()

    cleanup()

    // User check
    sessionMock.useMe.mockReturnValue({
      data: { user: { id: 'u3', role: 'user', username: 'user1' } },
    })
    renderGroupsView()
    expect(await screen.findByText('Corp')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Auto Sort All' })).toBeNull()
  })

  it('staff can toggle Auto-Sort Rules area on a group', async () => {
    renderGroupsView()
    expect(await screen.findByText('Corp')).toBeInTheDocument()

    const rulesBtn = screen.getByRole('button', { name: 'Auto-sort rules for Corp' })
    expect(rulesBtn).toHaveTextContent('Rules (0)')

    fireEvent.click(rulesBtn)

    await waitFor(() => {
      expect(screen.getByText('Auto-Sort Rules')).toBeInTheDocument()
      expect(screen.getByText('0/20 patterns')).toBeInTheDocument()
    })
  })
})

describe('GroupsView ungrouped devices link', () => {
  it('links to the ungrouped devices filter', async () => {
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/groups')
        return Promise.resolve({ data: { items: threeLevelTree } })
      if (path === '/admin/api/v1/stats/summary')
        return Promise.resolve({
          data: { groups: [{ id: null, name: 'Ungrouped', online: 1, total: 2 }] },
        })
      if (path === '/admin/api/v1/policies') return Promise.resolve({ data: { items: [] } })
      if (path === '/admin/api/v1/group-rules') return Promise.resolve({ data: { items: [] } })
      return Promise.reject(new Error(`unknown path: ${path}`))
    })
    renderGroupsView()
    const link = await screen.findByRole('link', { name: /ungrouped devices/i })
    expect(link).toHaveAttribute('href', '/devices?group=ungrouped')
  })
})

describe('GroupsView group counts roll up subgroups', () => {
  function node(id: string, name: string, children: Group[] = []): Group {
    return {
      id,
      name,
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'pol-default',
      children,
    }
  }

  function mockTree(tree: Group[], groups: { id: string | null; online: number; total: number }[]) {
    sessionMock.useMe.mockReturnValue({
      data: { user: { id: 'u1', role: 'admin', username: 'admin' } },
    })
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/groups') return Promise.resolve({ data: { items: tree } })
      if (path === '/admin/api/v1/stats/summary') return Promise.resolve({ data: { groups } })
      if (path === '/admin/api/v1/policies') {
        return Promise.resolve({ data: { items: [defaultPolicy] } })
      }
      if (path === '/admin/api/v1/group-rules') return Promise.resolve({ data: { items: [] } })
      return Promise.reject(new Error(`unknown path: ${path}`))
    })
  }

  function badgeOf(name: string): HTMLElement | null {
    const row = screen.getByText(name).closest('[data-slot="group-node"]')
    return row?.querySelector<HTMLElement>('[data-slot="group-count"]') ?? null
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('totals include subgroups with the own count beside them; leaves are unchanged', async () => {
    mockTree(
      [node('p', 'Parent', [node('c', 'Child', [node('g', 'Grandchild')])])],
      [
        { id: 'p', online: 1, total: 1 },
        { id: 'c', online: 0, total: 2 },
        { id: 'g', online: 2, total: 3 },
      ],
    )
    renderGroupsView()
    await screen.findByText('Parent')

    expect(badgeOf('Parent')).toHaveTextContent(/^3\s*\/\s*6 online\s*·\s*1 here$/)
    expect(badgeOf('Parent')).toHaveAttribute(
      'aria-label',
      '3 of 6 devices online, including subgroups; 1 in this group',
    )
    expect(badgeOf('Child')).toHaveTextContent(/^2\s*\/\s*5 online\s*·\s*2 here$/)
    expect(badgeOf('Grandchild')).toHaveTextContent(/^2\s*\/\s*3 online$/)
    expect(badgeOf('Grandchild')).not.toHaveTextContent('here')
  })

  it('a parent with no own devices shows 0 here; a group with nothing counted shows no badge', async () => {
    mockTree(
      [node('p', 'Parent', [node('c', 'Child')]), node('e', 'Empty', [node('e2', 'EmptyKid')])],
      [{ id: 'c', online: 1, total: 4 }],
    )
    renderGroupsView()
    await screen.findByText('Parent')

    expect(badgeOf('Parent')).toHaveTextContent(/^1\s*\/\s*4 online\s*·\s*0 here$/)
    expect(badgeOf('Child')).toHaveTextContent(/^1\s*\/\s*4 online$/)
    expect(badgeOf('Empty')).toBeNull()
    expect(badgeOf('EmptyKid')).toBeNull()
  })
})

describe('GroupsView mobile adaptation & responsiveness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionMock.useMe.mockReturnValue({
      data: { user: { id: 'u0', role: 'owner', username: 'owner1' } },
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders long group names (40+ chars) with title and preserves count badge without truncation', async () => {
    const longName = 'Infrastructure Engineering Production Services and Core Data Center Systems'
    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({
          data: {
            items: [
              {
                id: 'grp-long',
                name: longName,
                parent_id: null,
                policy_id: null,
                effective_policy_id: 'pol-default',
                children: [],
              },
            ],
          },
        })
      }
      if (path === '/admin/api/v1/stats/summary') {
        return Promise.resolve({
          data: {
            groups: [{ id: 'grp-long', online: 42, total: 100 }],
          },
        })
      }
      if (path === '/admin/api/v1/policies') {
        return Promise.resolve({ data: { items: [] } })
      }
      if (path === '/admin/api/v1/group-rules') {
        return Promise.resolve({ data: { items: [] } })
      }
      return Promise.reject(new Error(`unknown path: ${path}`))
    })

    renderGroupsView()

    const nameEl = await screen.findByText(longName)
    expect(nameEl).toBeInTheDocument()
    expect(nameEl).toHaveAttribute('title', longName)
    expect(nameEl).toHaveClass('truncate')

    const badge = screen.getByLabelText('42 of 100 devices online')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent('42/100 online')
    expect(badge).toHaveClass('shrink-0', 'whitespace-nowrap')
  })

  it('caps indentation on deep nesting for phones while preserving desktop indent', async () => {
    // 5-level deep hierarchy: L0 -> L1 -> L2 -> L3 -> L4
    const deepTree: Group[] = [
      {
        id: 'l0',
        name: 'Level 0',
        parent_id: null,
        policy_id: null,
        effective_policy_id: 'pol-default',
        children: [
          {
            id: 'l1',
            name: 'Level 1',
            parent_id: 'l0',
            policy_id: null,
            effective_policy_id: 'pol-default',
            children: [
              {
                id: 'l2',
                name: 'Level 2',
                parent_id: 'l1',
                policy_id: null,
                effective_policy_id: 'pol-default',
                children: [
                  {
                    id: 'l3',
                    name: 'Level 3',
                    parent_id: 'l2',
                    policy_id: null,
                    effective_policy_id: 'pol-default',
                    children: [
                      {
                        id: 'l4',
                        name: 'Level 4',
                        parent_id: 'l3',
                        policy_id: null,
                        effective_policy_id: 'pol-default',
                        children: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]

    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({ data: { items: deepTree } })
      }
      if (path === '/admin/api/v1/stats/summary') {
        return Promise.resolve({ data: { groups: [] } })
      }
      if (path === '/admin/api/v1/policies') {
        return Promise.resolve({ data: { items: [] } })
      }
      if (path === '/admin/api/v1/group-rules') {
        return Promise.resolve({ data: { items: [] } })
      }
      return Promise.reject(new Error(`unknown path: ${path}`))
    })

    renderGroupsView()

    await screen.findByText('Level 0')
    const l0Row = screen.getByText('Level 0').closest('[data-slot="group-node"]')!
      .firstElementChild as HTMLElement
    const l1Row = screen.getByText('Level 1').closest('[data-slot="group-node"]')!
      .firstElementChild as HTMLElement
    const l2Row = screen.getByText('Level 2').closest('[data-slot="group-node"]')!
      .firstElementChild as HTMLElement
    const l3Row = screen.getByText('Level 3').closest('[data-slot="group-node"]')!
      .firstElementChild as HTMLElement
    const l4Row = screen.getByText('Level 4').closest('[data-slot="group-node"]')!
      .firstElementChild as HTMLElement

    // Phone indents: 0.5, 1.5, 2.25, 2.75, capped at 3.0rem
    expect(l0Row.style.getPropertyValue('--phone-indent')).toBe('0.5rem')
    expect(l1Row.style.getPropertyValue('--phone-indent')).toBe('1.5rem')
    expect(l2Row.style.getPropertyValue('--phone-indent')).toBe('2.25rem')
    expect(l3Row.style.getPropertyValue('--phone-indent')).toBe('2.75rem')
    expect(l4Row.style.getPropertyValue('--phone-indent')).toBe('3rem')

    // Desktop indents are uncapped (Math.max(0.5, level * 1.5))
    expect(l0Row.style.getPropertyValue('--desktop-indent')).toBe('0.5rem')
    expect(l1Row.style.getPropertyValue('--desktop-indent')).toBe('1.5rem')
    expect(l2Row.style.getPropertyValue('--desktop-indent')).toBe('3rem')
    expect(l3Row.style.getPropertyValue('--desktop-indent')).toBe('4.5rem')
    expect(l4Row.style.getPropertyValue('--desktop-indent')).toBe('6rem')
  })

  it('renders leaf spacer matching chevron width and aligns level 0 siblings', async () => {
    const tree: Group[] = [
      {
        id: 'office',
        name: 'Office',
        parent_id: null,
        policy_id: null,
        effective_policy_id: 'pol-default',
        children: [
          {
            id: 'floor1',
            name: 'Floor 1',
            parent_id: 'office',
            policy_id: null,
            effective_policy_id: 'pol-default',
            children: [],
          },
        ],
      },
      {
        id: 'homelab',
        name: 'Home lab',
        parent_id: null,
        policy_id: null,
        effective_policy_id: 'pol-default',
        children: [],
      },
    ]

    apiMock.GET.mockImplementation((path: string) => {
      if (path === '/admin/api/v1/groups') {
        return Promise.resolve({ data: { items: tree } })
      }
      if (path === '/admin/api/v1/stats/summary') {
        return Promise.resolve({ data: { groups: [] } })
      }
      if (path === '/admin/api/v1/policies') {
        return Promise.resolve({ data: { items: [] } })
      }
      if (path === '/admin/api/v1/group-rules') {
        return Promise.resolve({ data: { items: [] } })
      }
      return Promise.reject(new Error(`unknown path: ${path}`))
    })

    renderGroupsView()

    await screen.findByText('Office')
    await screen.findByText('Home lab')

    const officeRow = screen.getByText('Office').closest('[data-slot="group-node"]')!
      .firstElementChild as HTMLElement
    const homelabRow = screen.getByText('Home lab').closest('[data-slot="group-node"]')!
      .firstElementChild as HTMLElement

    // Both level 0 rows have identical indent on phone and desktop
    expect(officeRow.style.getPropertyValue('--phone-indent')).toBe('0.5rem')
    expect(homelabRow.style.getPropertyValue('--phone-indent')).toBe('0.5rem')
    expect(officeRow.style.getPropertyValue('--desktop-indent')).toBe('0.5rem')
    expect(homelabRow.style.getPropertyValue('--desktop-indent')).toBe('0.5rem')

    // Office has expand/collapse button with size-9 sm:size-5
    const chevronBtn = screen.getByRole('button', { name: 'Collapse group' })
    expect(chevronBtn.className).toContain('size-9')
    expect(chevronBtn.className).toContain('sm:size-5')

    // Home lab (leaf) has leaf spacer with matching size-9 sm:size-5
    const leafSpacer = homelabRow.querySelector('[data-slot="group-leaf-spacer"]')
    expect(leafSpacer).not.toBeNull()
    expect(leafSpacer?.className).toContain('size-9')
    expect(leafSpacer?.className).toContain('sm:size-5')
  })
})
