// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const publicDir = fileURLToPath(new URL('../public/', import.meta.url))
const manifest = JSON.parse(readFileSync(`${publicDir}manifest.json`, 'utf8')) as {
  id: string
  name: string
  short_name: string
  description: string
  start_url: string
  scope: string
  display: string
  background_color: string
  theme_color: string
  icons: { src: string; sizes: string; type: string; purpose: string }[]
}

function pngSize(path: string): [number, number] {
  const png = readFileSync(path)
  expect(png.toString('ascii', 1, 4)).toBe('PNG')
  return [png.readUInt32BE(16), png.readUInt32BE(20)]
}

describe('PWA manifest', () => {
  it('has the app identity and display fields', () => {
    expect(manifest).toMatchObject({
      id: '/',
      name: 'Ferricade',
      short_name: 'Ferricade',
      description: 'Admin console for a self-hosted RustDesk server',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#181A1D',
      theme_color: '#181A1D',
    })
  })

  it('has existing PNG icons with dimensions matching their declared sizes', () => {
    for (const icon of manifest.icons) {
      const path = `${publicDir}${icon.src.slice(1)}`
      expect(existsSync(path), icon.src).toBe(true)
      const [width, height] = pngSize(path)
      const [expectedWidth, expectedHeight] = icon.sizes.split('x').map(Number)
      expect([width, height], icon.src).toEqual([expectedWidth, expectedHeight])
    }
  })

  it('has a 180 by 180 Apple touch icon', () => {
    expect(pngSize(`${publicDir}icons/apple-touch-icon.png`)).toEqual([180, 180])
  })
})
