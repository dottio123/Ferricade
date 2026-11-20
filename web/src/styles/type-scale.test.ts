/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ARBITRARY_TEXT_REGEX = /text-\[\d+(?:\.\d+)?(?:px|rem)\]/
const SVG_FONT_SIZE_REGEX = /fontSize\s*(?::\s*|=\s*\{?)(\d+(?:\.\d+)?)/g
const TERNARY_FONT_SIZE_REGEX = /fontSize\s*:\s*[^\n?]+\?\s*\d+(?:\.\d+)?\s*:\s*(\d+(?:\.\d+)?)/g

function getSourceFiles(dir: string): string[] {
  const files: string[] = []
  const entries = readdirSync(dir)

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      files.push(...getSourceFiles(fullPath))
    } else if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx') || entry.endsWith('.css')) &&
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

describe('Type scale floor and arbitrary text sizes', () => {
  it('keeps numeric SVG font sizes at 12px or above', () => {
    const srcDir = resolve(process.cwd(), 'src')
    const violations = getSourceFiles(srcDir).flatMap((file) =>
      readFileSync(file, 'utf-8')
        .split('\n')
        .flatMap((line, index) =>
          [...line.matchAll(SVG_FONT_SIZE_REGEX), ...line.matchAll(TERNARY_FONT_SIZE_REGEX)]
            .filter((match) => Number(match[1]) < 12)
            .map((match) => `${file.replace(srcDir, 'src')}:${index + 1} ${match[0]}`),
        ),
    )
    expect(violations).toEqual([])
  })
  it('ensures no source file uses arbitrary text-[Npx] or text-[Nrem] sizes', () => {
    const srcDir = resolve(process.cwd(), 'src')
    const sourceFiles = getSourceFiles(srcDir)

    expect(sourceFiles.length).toBeGreaterThan(0)

    const violations: { file: string; line: number; match: string }[] = []

    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n')

      lines.forEach((lineText, lineIdx) => {
        const match = lineText.match(ARBITRARY_TEXT_REGEX)
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
      expect.fail(`Found arbitrary text size classes:\n${details}`)
    }

    expect(violations).toEqual([])
  })
})
