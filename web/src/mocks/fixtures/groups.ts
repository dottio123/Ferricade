import type { MockSize } from '../config'
import { createRng } from './rng'
import type { GroupRow, Tag } from './types'

const argb = (hex: number) => hex >>> 0
export const DEFAULT_POLICY_ID = '00000000-0000-4000-8000-000000000001'

const TAGS: Array<[string, number]> = [
  ['server', argb(0xff2196f3)],
  ['laptop', argb(0xff4caf50)],
  ['kiosk', argb(0xffff9800)],
  ['vip', argb(0xff9c27b0)],
  ['lab', argb(0xff009688)],
  ['remote', argb(0xff795548)],
  ['loaner', argb(0xffe91e63)],
  ['dev', argb(0xff3f51b5)],
  ['finance', argb(0xfff44336)],
  ['spare', argb(0xff607d8b)],
]

// [name, parent name]
const GROUPS: Record<MockSize, Array<[string, string | null]>> = {
  small: [
    ['Home', null],
    ['Office', null],
  ],
  medium: [
    ['Office', null],
    ['Reception', 'Office'],
    ['Engineering', 'Office'],
    ['Home lab', null],
    ['Remote staff', null],
  ],
  large: [
    ['Headquarters', null],
    ['Reception', 'Headquarters'],
    ['Engineering', 'Headquarters'],
    ['Finance', 'Headquarters'],
    ['Branch offices', null],
    ['Berlin', 'Branch offices'],
    ['Austin', 'Branch offices'],
    ['Tokyo', 'Branch offices'],
    ['Home lab', null],
    ['Remote staff', null],
    ['Kiosks', null],
  ],
}

export function createGroupsAndTags(size: MockSize): { groups: GroupRow[]; tags: Tag[] } {
  const rng = createRng(0x6770 + size.length)
  const byName = new Map<string, string>()
  const groups: GroupRow[] = GROUPS[size].map(([name, parent]) => {
    const id = rng.uuid()
    byName.set(name, id)
    return {
      id,
      name,
      parent_id: parent ? (byName.get(parent) ?? null) : null,
      policy_id: null,
      effective_policy_id: DEFAULT_POLICY_ID,
    }
  })
  const tagCount = size === 'small' ? 3 : size === 'medium' ? 6 : 10
  const tags: Tag[] = TAGS.slice(0, tagCount).map(([name, color]) => ({
    id: rng.uuid(),
    name,
    color,
  }))
  return { groups, tags }
}
