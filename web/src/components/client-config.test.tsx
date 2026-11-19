import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ClientConfig } from './client-config'

afterEach(cleanup)

const mockConfig = {
  config_string: 'mock-config-string-xyz',
  deep_link: 'rustdesk://config/mock-config-string-xyz',
  api: 'http://rd.example.com:21114',
  host: 'rd.example.com',
  relay: 'relay.example.com',
  key: 'OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=',
  install: {
    windows: '& "$env:ProgramFiles\\RustDesk\\rustdesk.exe" --config mock-config-string-xyz',
    macos:
      'sudo /Applications/RustDesk.app/Contents/MacOS/RustDesk --config mock-config-string-xyz',
    linux: 'sudo rustdesk --config mock-config-string-xyz',
  },
}

describe('ClientConfig component', () => {
  it('renders all connection parameters and config string', () => {
    render(
      <TooltipProvider>
        <ClientConfig config={mockConfig} />
      </TooltipProvider>,
    )

    expect(screen.getByDisplayValue(mockConfig.config_string)).toBeInTheDocument()
    expect(screen.getByDisplayValue(mockConfig.host)).toBeInTheDocument()
    expect(screen.getByDisplayValue(mockConfig.relay)).toBeInTheDocument()
    expect(screen.getByDisplayValue(mockConfig.key)).toBeInTheDocument()
    expect(screen.getByDisplayValue(mockConfig.api)).toBeInTheDocument()
    expect(screen.getByDisplayValue(mockConfig.deep_link)).toBeInTheDocument()
    expect(screen.getByText(/mobile clients only/i)).toBeInTheDocument()
  })

  it('renders OS install tabs and switches between them', () => {
    render(
      <TooltipProvider>
        <ClientConfig config={mockConfig} />
      </TooltipProvider>,
    )

    // Windows is default
    expect(screen.getByDisplayValue(mockConfig.install.windows)).toBeInTheDocument()

    // Switch to macOS tab
    const macTab = screen.getByRole('tab', { name: 'macOS' })
    fireEvent.focus(macTab)
    fireEvent.keyDown(macTab, { key: ' ', code: 'Space', charCode: 32 })
    fireEvent.click(macTab)
    expect(screen.getByDisplayValue(mockConfig.install.macos)).toBeInTheDocument()

    // Switch to Linux tab
    const linuxTab = screen.getByRole('tab', { name: 'Linux' })
    fireEvent.focus(linuxTab)
    fireEvent.keyDown(linuxTab, { key: ' ', code: 'Space', charCode: 32 })
    fireEvent.click(linuxTab)
    expect(screen.getByDisplayValue(mockConfig.install.linux)).toBeInTheDocument()
  })
})
