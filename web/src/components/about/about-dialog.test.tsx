import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AboutDialog } from './about-dialog'

describe('AboutDialog', () => {
  it('shows the version, resets to About, and renders changelog releases and code', async () => {
    const view = render(<AboutDialog open onOpenChange={() => {}} />)
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          /^Version \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(element.textContent ?? ''),
      ),
    ).toBeVisible()
    const dialog = screen.getByRole('dialog', { name: 'About Ferricade' })
    const wordmark = dialog.querySelector('[data-brand-logo="wordmark"]')
    expect(wordmark).not.toBeNull()
    expect(wordmark).toHaveAttribute('data-brand-variant', 'rust')
    expect(wordmark).toHaveAttribute('aria-hidden', 'true')
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'Changelog' }), { button: 0 })
    const releases = Array.from(document.querySelectorAll('[data-slot="changelog-release"]'))
    expect(releases).toHaveLength(5)
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'About' }), { button: 0 })
    const version = screen
      .getByText(
        (_, element) => element?.tagName === 'P' && element.textContent?.startsWith('Version '),
      )
      .textContent?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0]
    expect(releases[0]?.querySelector('summary')?.textContent).toContain(version)
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'Changelog' }), { button: 0 })
    expect(screen.getByRole('link', { name: 'Full changelog on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/dottio123/ferricade/blob/main/CHANGELOG.md',
    )
    expect(screen.getByRole('link', { name: 'Full changelog on GitHub' })).toHaveAttribute(
      'target',
      '_blank',
    )
    expect(screen.getByRole('link', { name: 'Full changelog on GitHub' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    )
    expect(releases[0]).toHaveAttribute('open')
    expect(releases.slice(1).every((release) => !release.hasAttribute('open'))).toBe(true)
    releases[0]?.querySelector('summary')?.click()
    expect(releases[0]?.querySelector('li')?.textContent).toBeTruthy()
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'About' }), { button: 0 })
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'Changelog' }), { button: 0 })
    expect(document.querySelector('[data-slot="changelog-release"]')).toHaveAttribute('open')
    view.rerender(<AboutDialog open={false} onOpenChange={() => {}} />)
    view.rerender(<AboutDialog open onOpenChange={() => {}} />)
    expect(screen.getByRole('tab', { name: 'About' })).toHaveAttribute('aria-selected', 'true')
  })
})
