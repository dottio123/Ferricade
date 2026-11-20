import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UserAvatar } from './user-avatar'

describe('UserAvatar', () => {
  it('renders initials when src is empty', () => {
    render(<UserAvatar name="admin" />)
    expect(screen.getByText('AD')).toBeInTheDocument()
  })

  it('renders initials for two-word names', () => {
    render(<UserAvatar name="Jane Doe" />)
    expect(screen.getByText('JD')).toBeInTheDocument()
  })

  it('renders image when src is provided', () => {
    render(<UserAvatar name="admin" src="https://example.com/avatar.png" />)
    const img = screen.getByRole('presentation', { hidden: true })
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.png')
    expect(img).toHaveAttribute('alt', '')
  })
})
