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
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'Changelog' }), { button: 0 })
    await screen.findByText(
      'An About window, opened from the bottom of the sidebar, shows the version and this changelog.',
    )
    const releases = Array.from(document.querySelectorAll('[data-slot="changelog-release"]'))
    expect(releases[0]).toHaveAttribute('open')
    expect(releases.slice(1).every((release) => !release.hasAttribute('open'))).toBe(true)
    const release060 = releases.find((release) => release.textContent?.includes('0.6.0'))
    release060?.querySelector('summary')?.click()
    expect(release060?.querySelector('code')?.textContent).toContain('user set-password')
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'About' }), { button: 0 })
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'Changelog' }), { button: 0 })
    expect(document.querySelector('[data-slot="changelog-release"]')).toHaveAttribute('open')
    view.rerender(<AboutDialog open={false} onOpenChange={() => {}} />)
    view.rerender(<AboutDialog open onOpenChange={() => {}} />)
    expect(screen.getByRole('tab', { name: 'About' })).toHaveAttribute('aria-selected', 'true')
  })
})
