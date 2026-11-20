import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { currentVersion, parseChangelog } from './changelog'

const changelogText = readFileSync(resolve(process.cwd(), '../CHANGELOG.md'), 'utf8')

describe('parseChangelog', () => {
  it('parses SemVer prerelease versions and uses them as the current version', () => {
    const releases = parseChangelog(
      [
        '## [Unreleased]',
        '### Added',
        '- Next release',
        '## [1.0.0-rc.1] - 2026-10-13',
        '### Added',
        '- Release candidate',
        '## [0.7.0] - 2026-10-12',
        '### Added',
        '- Previous release',
      ].join('\n'),
    )

    expect(releases).toHaveLength(3)
    expect(releases.map((release) => release.version)).toEqual([
      'Unreleased',
      '1.0.0-rc.1',
      '0.7.0',
    ])
    expect(releases[1]?.sections).toEqual([{ heading: 'Added', items: ['Release candidate'] }])
    expect(currentVersion(releases)).toBe('1.0.0-rc.1')
  })

  it('parses releases, sections, code, and CRLF while ignoring unrelated markdown', () => {
    const releases = parseChangelog(
      [
        'Intro prose',
        '## [Unreleased]',
        'prose',
        '### Added',
        '- An `About` window',
        '## [2.0.0] - 2026-01-02',
        '### Changed',
        '- changed',
        '### Fixed',
        '- fixed',
        '### Security',
        '- safe',
        '[2.0.0]: https://example.com',
        '## [1.0.0] - 2025-01-01',
        '### Added',
        '- old',
      ].join('\r\n'),
    )

    expect(releases).toEqual([
      {
        version: 'Unreleased',
        date: null,
        sections: [{ heading: 'Added', items: ['An `About` window'] }],
      },
      {
        version: '2.0.0',
        date: '2026-01-02',
        sections: [
          { heading: 'Changed', items: ['changed'] },
          { heading: 'Fixed', items: ['fixed'] },
          { heading: 'Security', items: ['safe'] },
        ],
      },
      { version: '1.0.0', date: '2025-01-01', sections: [{ heading: 'Added', items: ['old'] }] },
    ])
    expect(parseChangelog('## [Unreleased]\n### Added')).toEqual([])
    expect(parseChangelog('## [1.0.0]\n### Added\n- missing date')).toEqual([])
  })

  it('finds every published release in the real changelog', () => {
    const releases = parseChangelog(changelogText)
    const datedReleases = releases.filter((release) => release.date !== null)
    const versions = datedReleases.map((release) => release.version)
    const compareSemVer = (left: string, right: string) => {
      const [leftCore = '', leftPre] = left.split('-', 2)
      const [rightCore = '', rightPre] = right.split('-', 2)
      const leftParts = leftCore.split('.').map(Number)
      const rightParts = rightCore.split('.').map(Number)
      for (let index = 0; index < 3; index += 1) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
        if (difference !== 0) return difference
      }
      if (leftPre === rightPre) return 0
      if (leftPre === undefined) return 1
      if (rightPre === undefined) return -1
      return leftPre.localeCompare(rightPre, 'en', { numeric: true })
    }

    expect(versions).toEqual(
      expect.arrayContaining(['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0']),
    )
    for (let index = 1; index < versions.length; index += 1) {
      expect(compareSemVer(versions[index - 1] ?? '', versions[index] ?? '')).toBeGreaterThan(0)
    }
    expect(
      datedReleases.every((release) =>
        release.sections.some((section) => section.items.length > 0),
      ),
    ).toBe(true)
    expect(currentVersion(releases)).toBe(versions[0])
    expect(currentVersion(releases)).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })
})
