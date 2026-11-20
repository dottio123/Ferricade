import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { components } from '@/api/schema'
import { ToasterProvider } from '@/components/ui/toast'
import { GroupRulesSection } from './group-rules-section'

type Group = components['schemas']['Group']
type GroupRule = components['schemas']['GroupRule']

const mockGroup: Group = {
  id: 'grp-test',
  name: 'Engineering',
  parent_id: null,
  policy_id: null,
  effective_policy_id: 'pol-1',
  children: [],
}

const mockRules: GroupRule[] = [
  {
    id: 'rule-1',
    group_id: 'grp-test',
    pattern: 'w-*-it-*',
    created_at: '2026-10-22T10:00:00Z',
    created_by: null,
  },
]

function renderSection(rules: GroupRule[] = mockRules) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ToasterProvider>
        <GroupRulesSection group={mockGroup} rules={rules} />
      </ToasterProvider>
    </QueryClientProvider>,
  )
}

describe('GroupRulesSection', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders existing rules and removing a rule sends DELETE', async () => {
    const deleteSpy = vi.spyOn(api, 'DELETE').mockResolvedValue({} as never)

    renderSection()

    expect(screen.getByText('w-*-it-*')).toBeInTheDocument()
    expect(screen.getByText('1/20 patterns')).toBeInTheDocument()

    const removeBtn = screen.getByRole('button', { name: 'Remove pattern w-*-it-*' })
    fireEvent.click(removeBtn)

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('/admin/api/v1/groups/{id}/rules/{rule_id}', {
        params: { path: { id: 'grp-test', rule_id: 'rule-1' } },
      })
    })
  })

  it('validates pattern and sends debounced preview with live text', async () => {
    const previewSpy = vi.spyOn(api, 'POST').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/groups/{id}/rules/preview') {
        return Promise.resolve({
          data: {
            match_count: 12,
            conflict_count: 1,
            matches: [
              {
                id: 'd-1',
                rustdesk_id: '123',
                hostname: 'w-sf-it-01',
                alias: 'PC 1',
                state: 'approved',
                group_id: 'grp-test',
              },
              {
                id: 'd-2',
                rustdesk_id: '456',
                hostname: 'w-sf-it-02',
                alias: 'PC 2',
                state: 'pending',
                group_id: null,
              },
            ],
            conflicts: [
              {
                device: {
                  id: 'd-3',
                  rustdesk_id: '789',
                  hostname: 'w-sf-it-conflict',
                  alias: 'PC 3',
                  state: 'approved',
                  group_id: null,
                },
                groups: [{ id: 'grp-support', name: 'Support' }],
              },
            ],
          },
        } as never)
      }
      return Promise.reject(new Error(`Unhandled POST ${path}`))
    })

    renderSection()

    const input = screen.getByPlaceholderText('e.g. w-*-it-*')
    fireEvent.change(input, { target: { value: 'w-sf-*' } })

    // Wait for debounced preview call
    await waitFor(
      () => {
        expect(previewSpy).toHaveBeenCalledWith('/admin/api/v1/groups/{id}/rules/preview', {
          params: { path: { id: 'grp-test' } },
          body: { pattern: 'w-sf-*' },
        })
      },
      { timeout: 2000 },
    )

    // Verify preview text summary
    await waitFor(() => {
      expect(
        screen.getByText(
          (content) =>
            content.includes('Matches 12 devices') &&
            content.includes('(1 pending)') &&
            content.includes('1 conflict'),
        ),
      ).toBeInTheDocument()
    })
  })

  it('does not send invalid pattern to preview and shows error at the field', async () => {
    const postSpy = vi.spyOn(api, 'POST')

    renderSection()

    const input = screen.getByPlaceholderText('e.g. w-*-it-*')
    // Invalid characters: spaces and symbols
    fireEvent.change(input, { target: { value: 'invalid pattern!' } })

    await waitFor(() => {
      expect(
        screen.getByText('Pattern may only contain letters, numbers, and . _ * ? -'),
      ).toBeInTheDocument()
    })

    expect(postSpy).not.toHaveBeenCalled()
  })

  it('submitting pattern sends POST and surfaces pattern_taken at the field', async () => {
    vi.spyOn(api, 'POST').mockImplementation((path: string) => {
      if (path === '/admin/api/v1/groups/{id}/rules/preview') {
        return Promise.resolve({
          data: { match_count: 0, conflict_count: 0, matches: [], conflicts: [] },
        } as never)
      }
      if (path === '/admin/api/v1/groups/{id}/rules') {
        return Promise.reject(
          new ApiError(409, 'pattern_taken', 'Pattern already exists in this group'),
        )
      }
      return Promise.reject(new Error(`Unhandled POST ${path}`))
    })

    renderSection()

    const input = screen.getByPlaceholderText('e.g. w-*-it-*')
    fireEvent.change(input, { target: { value: 'w-*-it-*' } })

    const addBtn = screen.getByRole('button', { name: 'Add' })
    fireEvent.click(addBtn)

    await waitFor(() => {
      expect(screen.getByText('This pattern already exists in this group.')).toBeInTheDocument()
    })
  })
})
