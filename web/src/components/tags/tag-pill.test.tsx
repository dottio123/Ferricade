import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TagPill } from './tag-pill'

describe('TagPill', () => {
  it('renders pill with natural width styling and accessible title', () => {
    render(<TagPill name="production-database-cluster-primary" color={0x22c55e} />)

    const pill = screen
      .getByText('production-database-cluster-primary')
      .closest('[data-slot="tag-pill"]')
    expect(pill).toBeInTheDocument()
    expect(pill).toHaveAttribute('title', 'production-database-cluster-primary')
    expect(pill?.className).toContain('w-fit')
    expect(pill?.className).toContain('self-start')
    expect(pill?.className).toContain('max-w-full')
    expect(pill?.className).toContain('truncate')
  })
})
