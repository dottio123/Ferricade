import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TotpQr } from './totp-qr'

describe('TotpQr component', () => {
  it('renders an SVG QR code with quiet zone and role=img', () => {
    const url = 'otpauth://totp/ferricade:alex?secret=JBSWY3DPEHPK3PXP&issuer=ferricade'
    render(<TotpQr otpauthUrl={url} />)

    const svg = screen.getByRole('img', { name: 'QR code for your authenticator app' })
    expect(svg).toBeInTheDocument()
    expect(svg.tagName.toLowerCase()).toBe('svg')

    const rect = svg.querySelector('rect')
    expect(rect).not.toBeNull()
    expect(rect?.getAttribute('fill')).toBe('#ffffff')

    const path = svg.querySelector('path')
    expect(path).not.toBeNull()
    expect(path?.getAttribute('fill')).toBe('#000000')
    expect(path?.getAttribute('d')).toContain('M')
  })
})
