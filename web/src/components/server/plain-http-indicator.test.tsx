import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { queryKeys } from '../../lib/queryKeys'
import { PLAIN_HTTP_NOTICE, PlainHttpIndicator } from './plain-http-indicator'

function mountWithStatus(status: Record<string, unknown>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(queryKeys.setupStatus(), status)
  return render(
    <QueryClientProvider client={client}>
      <PlainHttpIndicator />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
})

describe('PlainHttpIndicator', () => {
  it('renders nothing when plain_http is false', () => {
    const { container } = mountWithStatus({ setup_complete: true, plain_http: false })
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when plain_http is missing', () => {
    const { container } = mountWithStatus({ setup_complete: true })
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the indicator with an accessible name and reveals the explanation by keyboard', async () => {
    mountWithStatus({ setup_complete: true, plain_http: true })

    const trigger = screen.getByRole('button', { name: 'Plain HTTP connection' })
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveTextContent('HTTP')
    expect(screen.queryByText(PLAIN_HTTP_NOTICE)).not.toBeInTheDocument()

    // Keyboard focus reveals the explanation without leaving the trigger
    fireEvent.focus(trigger)
    expect(await screen.findByText(PLAIN_HTTP_NOTICE)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Plain HTTP notice' })).toBeInTheDocument()

    // Blur hides it
    fireEvent.blur(trigger)
    expect(screen.queryByText(PLAIN_HTTP_NOTICE)).not.toBeInTheDocument()

    // Keyboard click / Enter pins it open and Escape closes it
    fireEvent.click(trigger)
    expect(await screen.findByText(PLAIN_HTTP_NOTICE)).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText(PLAIN_HTTP_NOTICE)).not.toBeInTheDocument()
  })
})
