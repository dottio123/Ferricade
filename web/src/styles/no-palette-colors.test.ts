/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PALETTE_REGEX =
  /(text|bg|border|ring|fill|stroke|from|to)-(red|amber|emerald|green|yellow|blue|slate|gray|zinc|neutral|orange|sky|indigo|violet|purple|pink|rose|lime|teal|cyan|stone)-\d/

function getSourceFiles(dir: string): string[] {
  const files: string[] = []
  const entries = readdirSync(dir)

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      files.push(...getSourceFiles(fullPath))
    } else if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.spec.tsx')
    ) {
      files.push(fullPath)
    }
  }

  return files
}

describe('No hard-coded Tailwind palette colors', () => {
  it('ensures no source file uses hard-coded palette utility classes', () => {
    const srcDir = resolve(process.cwd(), 'src')
    const sourceFiles = getSourceFiles(srcDir)

    expect(sourceFiles.length).toBeGreaterThan(0)

    const violations: { file: string; line: number; match: string }[] = []

    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n')

      lines.forEach((lineText, lineIdx) => {
        const match = lineText.match(PALETTE_REGEX)
        if (match) {
          violations.push({
            file: file.replace(srcDir, 'src'),
            line: lineIdx + 1,
            match: match[0],
          })
        }
      })
    }

    if (violations.length > 0) {
      const details = violations.map((v) => `${v.file}:${v.line} uses ${v.match}`).join('\n')
      expect.fail(`Found hard-coded Tailwind palette utility classes:\n${details}`)
    }

    expect(violations).toEqual([])
  })
})
