import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/errors'
import {
  findGroupById,
  flattenGroups,
  getDescendantIds,
  mapGroupError,
  type Group,
} from './group-utils'

const sampleTree: Group[] = [
  {
    id: 'root-1',
    parent_id: null,
    name: 'Office',
    policy_id: null,
    effective_policy_id: '00000000-0000-4000-8000-000000000001',
    children: [
      {
        id: 'child-1-1',
        parent_id: 'root-1',
        name: 'Reception',
        policy_id: null,
        effective_policy_id: '00000000-0000-4000-8000-000000000001',
        children: [],
      },
      {
        id: 'child-1-2',
        parent_id: 'root-1',
        name: 'Engineering',
        policy_id: null,
        effective_policy_id: '00000000-0000-4000-8000-000000000001',
        children: [
          {
            id: 'grandchild-1',
            parent_id: 'child-1-2',
            name: 'DevOps',
            policy_id: null,
            effective_policy_id: '00000000-0000-4000-8000-000000000001',
            children: [],
          },
        ],
      },
    ],
  },
  {
    id: 'root-2',
    parent_id: null,
    name: 'Home lab',
    policy_id: null,
    effective_policy_id: '00000000-0000-4000-8000-000000000001',
    children: [],
  },
]

describe('group-utils', () => {
  it('finds group by id', () => {
    expect(findGroupById(sampleTree, 'root-1')?.name).toBe('Office')
    expect(findGroupById(sampleTree, 'grandchild-1')?.name).toBe('DevOps')
    expect(findGroupById(sampleTree, 'nonexistent')).toBeNull()
  })

  it('collects all descendant IDs including self', () => {
    const root1 = findGroupById(sampleTree, 'root-1')!
    const ids = getDescendantIds(root1)
    expect(ids.size).toBe(4)
    expect(ids.has('root-1')).toBe(true)
    expect(ids.has('child-1-1')).toBe(true)
    expect(ids.has('child-1-2')).toBe(true)
    expect(ids.has('grandchild-1')).toBe(true)

    const leaf = findGroupById(sampleTree, 'child-1-1')!
    expect(Array.from(getDescendantIds(leaf))).toEqual(['child-1-1'])
  })

  it('flattens group tree with depth', () => {
    const flattened = flattenGroups(sampleTree)
    expect(flattened.map((f) => ({ name: f.group.name, depth: f.depth }))).toEqual([
      { name: 'Office', depth: 0 },
      { name: 'Reception', depth: 1 },
      { name: 'Engineering', depth: 1 },
      { name: 'DevOps', depth: 2 },
      { name: 'Home lab', depth: 0 },
    ])
  })

  it('maps group errors to calm sentences', () => {
    const nameTaken = new ApiError(409, 'name_taken', 'duplicate')
    expect(mapGroupError(nameTaken)).toBe('A group with this name already exists here.')

    const notEmpty = new ApiError(409, 'not_empty', 'has children')
    expect(mapGroupError(notEmpty)).toBe(
      'This group still has subgroups or devices. Move them out first.',
    )

    const cycle = new ApiError(409, 'cycle', 'cycle detected')
    expect(mapGroupError(cycle)).toBe("A group can't be moved inside itself.")

    const other = new ApiError(400, 'bad_request', 'custom message')
    expect(mapGroupError(other)).toBe('custom message')
  })
})
