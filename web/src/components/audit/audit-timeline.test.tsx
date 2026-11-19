import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditTimeline } from './audit-timeline'
import type { AuditEvent } from '@/features/audit/describe'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}))

vi.mock('@/features/audit/use-device-names', () => ({
  useAuditDeviceNames: () => new Map(),
}))

afterEach(cleanup)

function groupRuleEvent(details: Record<string, unknown>): AuditEvent {
  return {
    id: 'event-1',
    at: '2026-10-24T12:00:00Z',
    actor_user_id: null,
    actor_ip: '192.168.1.1',
    action: 'group.rule_removed',
    target_type: 'group',
    target_id: 'group-1',
    details: { name: 'SIA', pattern: 'w-*', ...details },
  }
}

function renderEvent(event: AuditEvent) {
  return render(
    <TooltipProvider>
      <AuditTimeline events={[event]} resolveActor={() => 'You'} isOwner />
    </TooltipProvider>,
  )
}

describe('AuditTimeline', () => {
  it('renders rule conflict counts after the linked group name', () => {
    renderEvent(groupRuleEvent({ conflicts_resolved: ['device-1'] }))

    const item = screen.getByText('SIA').closest('[data-slot="audit-event-item"]')!
    const sentence = item.querySelector('.text-sm')!.textContent!.replace(/\s+/g, ' ').trim()
    expect(sentence).toBe('You removed the pattern `w-*` from group SIA (1 conflict resolved)')
  })

  it('renders no conflict suffix when there are no counts', () => {
    renderEvent(groupRuleEvent({}))

    const item = screen.getByText('SIA').closest('[data-slot="audit-event-item"]')!
    const sentence = item.querySelector('.text-sm')!.textContent!.replace(/\s+/g, ' ').trim()
    expect(sentence).toBe('You removed the pattern `w-*` from group SIA')
  })
})

it('renders the compact audit item with the suffix after the description and actor below', () => {
  const { container } = render(
    <TooltipProvider>
      <AuditTimeline
        events={[groupRuleEvent({ conflicts_resolved: ['device-1'] })]}
        resolveActor={() => 'You'}
        isOwner
        compact
      />
    </TooltipProvider>,
  )
  const entry = container.querySelector('[data-slot="device-audit-entry"]')!
  expect(entry).not.toBeNull()
  expect(entry.querySelector('[data-slot="device-audit-action"]')).toHaveTextContent(
    'removed the pattern `w-*` from group (1 conflict resolved)',
  )
  expect(entry.querySelector('[data-slot="device-audit-actor"]')).toHaveTextContent('You')
  expect(screen.queryByRole('button', { name: 'Show details' })).not.toBeInTheDocument()
})
