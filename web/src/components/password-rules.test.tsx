import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PasswordRules } from './password-rules'

describe('PasswordRules', () => {
  afterEach(cleanup)
  it('shows character count, case-insensitive username rule, neutral common-password rule, and matching', () => {
    const { rerender } = render(
      <PasswordRules password="ALEx" username="alex" confirmation="different" />,
    )
    expect(screen.getByText('At least 12 characters (4/12)').parentElement).toHaveTextContent(
      'not met',
    )
    expect(
      screen.getByText('Not your username, in any capitalisation').parentElement,
    ).toHaveTextContent('not met')
    const commonRule = screen.getByText(/Not a commonly used password/).parentElement!
    expect(commonRule).toHaveTextContent('Not a commonly used password (checked when you save)')
    expect(commonRule).toHaveClass('text-muted-foreground')
    expect(commonRule.querySelector('svg')).toHaveClass('lucide-circle-dashed', 'shrink-0')
    expect(screen.getByText('Passwords match').parentElement).toHaveTextContent('not met')

    rerender(
      <PasswordRules
        password="a sufficiently long password"
        username="alex"
        confirmation="a sufficiently long password"
      />,
    )
    expect(screen.getByText('At least 12 characters (28/12)').parentElement).toHaveTextContent(
      'met',
    )
    expect(
      screen.getByText('Not your username, in any capitalisation').parentElement,
    ).toHaveTextContent('met')
    expect(screen.getByText('Passwords match').parentElement).toHaveTextContent('met')
  })

  it('shows the server weak-password message and clears it when the password changes', () => {
    const { rerender } = render(
      <PasswordRules
        password="a sufficiently long password"
        username="alex"
        weakPasswordMessage="Choose a less common password."
      />,
    )
    expect(screen.getByText('Choose a less common password.')).toBeInTheDocument()
    expect(screen.getByText(/Not a commonly used password/).parentElement).toHaveTextContent(
      'not met',
    )
    expect(screen.getByText(/Not a commonly used password/).parentElement).toHaveClass(
      'text-destructive',
    )
    expect(screen.getByText(/Not a commonly used password/).parentElement).not.toHaveTextContent(
      'checked when you save',
    )
    expect(
      screen.getByText(/Not a commonly used password/).parentElement?.querySelector('svg'),
    ).toHaveClass('lucide-x', 'shrink-0')
    rerender(<PasswordRules password="a new sufficiently long password" username="alex" />)
    expect(screen.queryByText('Choose a less common password.')).toBeNull()
    expect(screen.getByText(/Not a commonly used password/).parentElement).toHaveTextContent(
      'Not a commonly used password (checked when you save)',
    )
  })
})
