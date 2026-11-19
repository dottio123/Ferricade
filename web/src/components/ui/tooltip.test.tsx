import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

// One TooltipProvider at the app root (src/App.tsx) serves every tooltip; a
// Tooltip must not bring its own, or the root's delay and shared state do nothing.
describe('Tooltip', () => {
  const tip = (
    <Tooltip>
      <TooltipTrigger>id</TooltipTrigger>
      <TooltipContent>full id</TooltipContent>
    </Tooltip>
  )

  it('relies on the TooltipProvider above it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(tip)).toThrow(/TooltipProvider/)
  })

  it('renders under one', () => {
    expect(() => render(<TooltipProvider>{tip}</TooltipProvider>)).not.toThrow()
  })
})
