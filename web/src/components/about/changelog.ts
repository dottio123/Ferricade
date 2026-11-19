export type ChangelogSection = {
  heading: 'Added' | 'Changed' | 'Fixed' | 'Security'
  items: string[]
}

export type ChangelogRelease = {
  version: string
  date: string | null
  sections: ChangelogSection[]
}

const sectionHeadings = new Set<ChangelogSection['heading']>([
  'Added',
  'Changed',
  'Fixed',
  'Security',
])

export function parseChangelog(text: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let release: ChangelogRelease | undefined
  let section: ChangelogSection | undefined

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const unreleasedHeading = line.match(/^## \[Unreleased\]$/)
    const releaseHeading = line.match(
      /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\] - (\d{4}-\d{2}-\d{2})$/,
    )
    if (unreleasedHeading || releaseHeading) {
      if (
        release &&
        (release.date !== null || release.sections.some((item) => item.items.length))
      ) {
        releases.push(release)
      }
      release = {
        version: unreleasedHeading ? 'Unreleased' : (releaseHeading?.[1] ?? ''),
        date: unreleasedHeading ? null : (releaseHeading?.[2] ?? null),
        sections: [],
      }
      section = undefined
      continue
    }

    if (!release) continue
    const sectionMatch = line.match(/^### (Added|Changed|Fixed|Security)$/)
    const sectionHeading = sectionMatch?.[1] as ChangelogSection['heading'] | undefined
    if (sectionHeading && sectionHeadings.has(sectionHeading)) {
      section = { heading: sectionHeading, items: [] }
      release.sections.push(section)
      continue
    }

    if (section && line.startsWith('- ')) section.items.push(line.slice(2))
  }

  if (release && (release.date !== null || release.sections.some((item) => item.items.length))) {
    releases.push(release)
  }
  return releases
}

export function currentVersion(releases: ChangelogRelease[]): string | null {
  return releases.find((release) => release.date !== null)?.version ?? null
}
