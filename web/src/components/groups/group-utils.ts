import { describeError } from '@/api/errors'
import type { components } from '@/api/schema'

export type Group = components['schemas']['Group']

/**
 * Returns a Set of IDs for the given group and all its descendants.
 */
export function getDescendantIds(group: Group): Set<string> {
  const ids = new Set<string>([group.id])
  function traverse(children: Group[]) {
    for (const child of children) {
      ids.add(child.id)
      if (child.children?.length) {
        traverse(child.children)
      }
    }
  }
  if (group.children?.length) {
    traverse(group.children)
  }
  return ids
}

/**
 * Flattens a tree of groups into an array with depth for dropdown rendering.
 */
export function flattenGroups(groups: Group[], depth = 0): Array<{ group: Group; depth: number }> {
  const result: Array<{ group: Group; depth: number }> = []
  for (const g of groups) {
    result.push({ group: g, depth })
    if (g.children?.length) {
      result.push(...flattenGroups(g.children, depth + 1))
    }
  }
  return result
}

/**
 * Finds a group by ID anywhere in the group tree.
 */
export function findGroupById(groups: Group[], id: string): Group | null {
  for (const g of groups) {
    if (g.id === id) return g
    if (g.children?.length) {
      const found = findGroupById(g.children, id)
      if (found) return found
    }
  }
  return null
}

/**
 * Maps API errors from group mutations into calm user-facing sentences.
 */
export function mapGroupError(err: unknown): string {
  const { code, message } = describeError(err)
  switch (code) {
    case 'name_taken':
      return 'A group with this name already exists here.'
    case 'not_empty':
      return 'This group still has subgroups or devices. Move them out first.'
    case 'cycle':
      return "A group can't be moved inside itself."
    default:
      return message
  }
}
