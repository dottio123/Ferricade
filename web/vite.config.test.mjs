// @vitest-environment node
// The mock build goes to dist-mock/ by default, so a mock build (even a manual
// `vite build --mode mock`) can never overwrite web/dist, which the Go binary embeds.
import { describe, expect, it } from 'vitest'
import config from './vite.config.ts'

const resolve = (mode) => config({ command: 'build', mode, isSsrBuild: false, isPreview: false })

describe('vite build output directory', () => {
  it('is dist/ for the production build, kept between builds (dist/.gitkeep)', () => {
    expect(resolve('production').build).toMatchObject({ outDir: 'dist', emptyOutDir: false })
  })

  it('is dist-mock/ for the mock build, emptied each time', () => {
    expect(resolve('mock').build).toMatchObject({ outDir: 'dist-mock', emptyOutDir: true })
  })
})
