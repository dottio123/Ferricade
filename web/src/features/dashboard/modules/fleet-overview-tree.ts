import type { components } from '@/api/schema'
import { getDescendantIds } from '@/components/groups/group-utils'

export type FleetMapDevice = components['schemas']['FleetMapDevice']
export type Group = components['schemas']['Group']

export interface FleetGroupNode {
  id: string | null
  name: string
  depth: number
  children: FleetGroupNode[]
  directDevices: FleetMapDevice[]
  allDevices: FleetMapDevice[]
  total: number
  online: number
  onlineClean: number
  alertCount: number
  offlineCount: number
  hasSubgroups: boolean
}

export interface WallRowsResult {
  visibleRows: FleetGroupNode[]
  hiddenHealthyCount: number
}

const STATUS_RANK: Record<FleetMapDevice['status'], number> = {
  alert: 0,
  offline: 1,
  online: 2,
}

/**
 * Orders devices by status: alert first, then offline, then online.
 * Within the same status, sorts alphabetically by name (case-insensitive, numeric-aware).
 * Pure function: does not mutate the input array.
 */
export function orderDevices(devices: readonly FleetMapDevice[]): FleetMapDevice[] {
  return [...devices].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
      a.id.localeCompare(b.id),
  )
}

/**
 * Builds a hierarchical fleet group tree with roll-ups over all descendants.
 * Top-level groups are ordered by name (case-insensitive).
 * "Ungrouped" is placed last, only if it has devices.
 * For users with restricted grants, devices in hidden groups sit in Ungrouped.
 */
export function buildFleetTree(
  groups: readonly Group[],
  devices: readonly FleetMapDevice[],
): {
  topLevelRows: FleetGroupNode[]
  totalApproved: number
  totalOffline: number
  totalAlert: number
} {
  const knownGroupIds = new Set<string>()
  for (const group of groups) {
    for (const id of getDescendantIds(group)) knownGroupIds.add(id)
  }

  // Partition devices by group_id
  const devicesByGroup = new Map<string, FleetMapDevice[]>()
  const ungroupedDevices: FleetMapDevice[] = []

  for (const d of devices) {
    if (d.group_id && knownGroupIds.has(d.group_id)) {
      let list = devicesByGroup.get(d.group_id)
      if (!list) {
        list = []
        devicesByGroup.set(d.group_id, list)
      }
      list.push(d)
    } else {
      ungroupedDevices.push(d)
    }
  }

  function processGroup(group: Group, depth: number): FleetGroupNode {
    const rawDirect = devicesByGroup.get(group.id) ?? []
    const directDevices = orderDevices(rawDirect)

    const rawChildren = group.children ? [...group.children] : []
    rawChildren.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
    )

    const children = rawChildren.map((child) => processGroup(child, depth + 1))

    // Rolled-up devices = direct devices + all descendant devices
    const allDescendantDevices = children.flatMap((c) => c.allDevices)
    const allDevices = orderDevices([...directDevices, ...allDescendantDevices])

    const alertCount = allDevices.filter((d) => d.status === 'alert').length
    const offlineCount = allDevices.filter((d) => d.status === 'offline').length
    const onlineClean = allDevices.filter((d) => d.status === 'online').length
    const total = allDevices.length
    const online = alertCount + onlineClean // non-offline devices

    return {
      id: group.id,
      name: group.name,
      depth,
      children,
      directDevices,
      allDevices,
      total,
      online,
      onlineClean,
      alertCount,
      offlineCount,
      hasSubgroups: children.length > 0,
    }
  }

  const topLevel = [...groups].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
  )
  const topLevelRows: FleetGroupNode[] = topLevel.map((g) => processGroup(g, 0))

  if (ungroupedDevices.length > 0) {
    const orderedUngrouped = orderDevices(ungroupedDevices)
    const alertCount = orderedUngrouped.filter((d) => d.status === 'alert').length
    const offlineCount = orderedUngrouped.filter((d) => d.status === 'offline').length
    const onlineClean = orderedUngrouped.filter((d) => d.status === 'online').length
    const total = orderedUngrouped.length
    const online = alertCount + onlineClean

    topLevelRows.push({
      id: null,
      name: 'Ungrouped',
      depth: 0,
      children: [],
      directDevices: orderedUngrouped,
      allDevices: orderedUngrouped,
      total,
      online,
      onlineClean,
      alertCount,
      offlineCount,
      hasSubgroups: false,
    })
  }

  const totalApproved = devices.length
  const totalOffline = devices.filter((d) => d.status === 'offline').length
  const totalAlert = devices.filter((d) => d.status === 'alert').length

  return {
    topLevelRows,
    totalApproved,
    totalOffline,
    totalAlert,
  }
}

/**
 * Determines whether a row's nodes exceed the line limit (2 lines in medium, 4 lines in large)
 * and should collapse to a proportional status bar.
 */
export function shouldCollapseToBar({
  deviceCount,
  availableWidth,
  nodeWidth = 24,
  gap = 8,
  maxLines,
}: {
  deviceCount: number
  availableWidth: number
  nodeWidth?: number
  gap?: number
  maxLines: number
}): boolean {
  if (deviceCount <= 0) return false
  if (availableWidth <= 0) return false
  const nodesPerLine = Math.max(1, Math.floor((availableWidth + gap) / (nodeWidth + gap)))
  return deviceCount > nodesPerLine * maxLines
}

/**
 * Formats the header badge text: "{total} devices · {offline} offline · {alert} alert" (zero parts omitted).
 */
export function formatHeaderBadgeText({
  total,
  offline,
  alert,
}: {
  total: number
  offline: number
  alert: number
}): string {
  const parts: string[] = [`${total} devices`]
  if (offline > 0) parts.push(`${offline} offline`)
  if (alert > 0) parts.push(`${alert} alert`)
  return parts.join(' · ')
}

/**
 * Formats a compact header badge text for narrow screens: "{total} · {offline} off · {alert} ⚠" (zero parts omitted).
 */
export function formatCompactHeaderBadgeText({
  total,
  offline,
  alert,
}: {
  total: number
  offline: number
  alert: number
}): string {
  const parts: string[] = [`${total}`]
  if (offline > 0) parts.push(`${offline} off`)
  if (alert > 0) parts.push(`${alert} ⚠`)
  return parts.join(' · ')
}

/**
 * Accessible text equivalent for a proportional status bar ("2 alert, 3 offline, 38 online").
 */
export function formatBarAccessibleText({
  alert,
  offline,
  online,
}: {
  alert: number
  offline: number
  online: number
}): string {
  const parts: string[] = []
  if (alert > 0) parts.push(`${alert} alert`)
  if (offline > 0) parts.push(`${offline} offline`)
  if (online > 0 || parts.length === 0) parts.push(`${online} online`)
  return parts.join(', ')
}

/**
 * Compact text equivalent for a status bar on narrow screens:
 * only non-zero problem counts (e.g. "2⚠ 30 off"), or "{online} online" if healthy.
 */
export function formatCompactBarText({
  alert,
  offline,
  online,
}: {
  alert: number
  offline: number
  online: number
}): string {
  const parts: string[] = []
  if (alert > 0) parts.push(`${alert}⚠`)
  if (offline > 0) parts.push(`${offline} off`)
  if (parts.length === 0) parts.push(`${online} online`)
  return parts.join(' ')
}

/**
 * Filter and sort rows for wall display:
 * - Top-level rows only.
 * - Rows with alert or offline devices first, then alphabetically by name.
 * - Does not scroll: excess healthy rows are replaced by "+N healthy groups".
 * - Never hides a group with problems before a healthy one.
 */
export function filterWallRows(
  topLevelRows: readonly FleetGroupNode[],
  maxRows: number,
): WallRowsResult {
  const sorted = [...topLevelRows].sort((a, b) => {
    const aProblem = a.alertCount > 0 || a.offlineCount > 0
    const bProblem = b.alertCount > 0 || b.offlineCount > 0
    if (aProblem !== bProblem) {
      return aProblem ? -1 : 1
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  })

  if (maxRows <= 0 || sorted.length <= maxRows) {
    return {
      visibleRows: sorted,
      hiddenHealthyCount: 0,
    }
  }

  const problemCount = sorted.filter((r) => r.alertCount > 0 || r.offlineCount > 0).length

  if (problemCount >= maxRows) {
    const visibleRows = sorted.slice(0, maxRows)
    const hiddenHealthyCount = sorted
      .slice(maxRows)
      .filter((r) => r.alertCount === 0 && r.offlineCount === 0).length
    return {
      visibleRows,
      hiddenHealthyCount,
    }
  }

  const healthyRows = sorted.filter((r) => r.alertCount === 0 && r.offlineCount === 0)
  const allowedHealthy = maxRows - 1 - problemCount
  const visibleHealthy = healthyRows.slice(0, allowedHealthy)
  const hiddenHealthyCount = healthyRows.length - visibleHealthy.length

  const visibleRows = [
    ...sorted.filter((r) => r.alertCount > 0 || r.offlineCount > 0),
    ...visibleHealthy,
  ]

  return {
    visibleRows,
    hiddenHealthyCount,
  }
}
