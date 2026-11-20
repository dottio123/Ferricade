import { describe, expect, it } from 'vitest'
import {
  buildFleetTree,
  filterWallRows,
  formatBarAccessibleText,
  formatCompactBarText,
  formatCompactHeaderBadgeText,
  formatHeaderBadgeText,
  orderDevices,
  shouldCollapseToBar,
  type FleetMapDevice,
  type Group,
} from './fleet-overview-tree'

const makeDevice = (
  id: string,
  name: string,
  group_id: string | null,
  status: FleetMapDevice['status'],
): FleetMapDevice => ({
  id,
  name,
  group_id,
  status,
})

describe('orderDevices', () => {
  it('orders alert -> offline -> online, then alphabetically by name ignoring case', () => {
    const devices: FleetMapDevice[] = [
      makeDevice('1', 'Zeta', 'g1', 'online'),
      makeDevice('2', 'alpha', 'g1', 'online'),
      makeDevice('3', 'Beta', 'g1', 'alert'),
      makeDevice('4', 'gamma', 'g1', 'offline'),
      makeDevice('5', 'Alpha-alert', 'g1', 'alert'),
      makeDevice('6', 'delta', 'g1', 'offline'),
    ]

    const ordered = orderDevices(devices)
    expect(ordered.map((d) => d.name)).toEqual([
      'Alpha-alert',
      'Beta',
      'delta',
      'gamma',
      'alpha',
      'Zeta',
    ])
  })

  it('does not mutate input array', () => {
    const devices = [makeDevice('1', 'b', 'g1', 'online'), makeDevice('2', 'a', 'g1', 'online')]
    const copy = [...devices]
    orderDevices(devices)
    expect(devices).toEqual(copy)
  })
})

describe('buildFleetTree', () => {
  it('rolls up counts and devices over a three-level tree', () => {
    // Level 0: Headquarters
    // Level 1: Engineering (child of Headquarters)
    // Level 2: Backend (child of Engineering)
    const backend: Group = {
      id: 'g-backend',
      name: 'Backend',
      parent_id: 'g-eng',
      policy_id: null,
      effective_policy_id: 'p1',
      children: [],
    }
    const eng: Group = {
      id: 'g-eng',
      name: 'Engineering',
      parent_id: 'g-hq',
      policy_id: null,
      effective_policy_id: 'p1',
      children: [backend],
    }
    const hq: Group = {
      id: 'g-hq',
      name: 'Headquarters',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [eng],
    }

    const devices: FleetMapDevice[] = [
      makeDevice('d-hq', 'HQ-Kiosk', 'g-hq', 'online'),
      makeDevice('d-eng-1', 'Eng-Lead', 'g-eng', 'alert'),
      makeDevice('d-eng-2', 'Eng-Doc', 'g-eng', 'offline'),
      makeDevice('d-be-1', 'API-01', 'g-backend', 'online'),
      makeDevice('d-be-2', 'DB-01', 'g-backend', 'online'),
    ]

    const { topLevelRows, totalApproved, totalOffline, totalAlert } = buildFleetTree([hq], devices)

    expect(totalApproved).toBe(5)
    expect(totalOffline).toBe(1)
    expect(totalAlert).toBe(1)

    expect(topLevelRows).toHaveLength(1)
    const hqRow = topLevelRows[0]!
    expect(hqRow.name).toBe('Headquarters')
    expect(hqRow.total).toBe(5) // 1 direct + 2 eng + 2 backend
    expect(hqRow.online).toBe(4) // 3 online + 1 alert (non-offline)
    expect(hqRow.alertCount).toBe(1)
    expect(hqRow.offlineCount).toBe(1)
    expect(hqRow.directDevices).toHaveLength(1)
    expect(hqRow.allDevices).toHaveLength(5)

    const engRow = hqRow.children[0]!
    expect(engRow.name).toBe('Engineering')
    expect(engRow.total).toBe(4) // 2 eng + 2 backend
    expect(engRow.online).toBe(3) // 2 online + 1 alert
    expect(engRow.alertCount).toBe(1)
    expect(engRow.offlineCount).toBe(1)
    expect(engRow.directDevices).toHaveLength(2)
    expect(engRow.allDevices).toHaveLength(4)

    const beRow = engRow.children[0]!
    expect(beRow.name).toBe('Backend')
    expect(beRow.total).toBe(2)
    expect(beRow.online).toBe(2)
    expect(beRow.directDevices).toHaveLength(2)
    expect(beRow.allDevices).toHaveLength(2)
  })

  it('shows right totals when a parent has devices only in subgroups', () => {
    // Parent group JCC has 0 direct devices, but Aquatics has 3 devices
    const aquatics: Group = {
      id: 'g-aqua',
      name: 'Aquatics',
      parent_id: 'g-jcc',
      policy_id: null,
      effective_policy_id: 'p1',
      children: [],
    }
    const jcc: Group = {
      id: 'g-jcc',
      name: 'JCC',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [aquatics],
    }

    const devices: FleetMapDevice[] = [
      makeDevice('d1', 'Pool-01', 'g-aqua', 'online'),
      makeDevice('d2', 'Pool-02', 'g-aqua', 'online'),
      makeDevice('d3', 'Pool-03', 'g-aqua', 'offline'),
    ]

    const { topLevelRows } = buildFleetTree([jcc], devices)
    const jccRow = topLevelRows[0]!
    expect(jccRow.directDevices).toHaveLength(0)
    expect(jccRow.allDevices).toHaveLength(3)
    expect(jccRow.total).toBe(3)
    expect(jccRow.online).toBe(2)
    expect(jccRow.offlineCount).toBe(1)
  })

  it('puts a Users hidden-group devices under Ungrouped', () => {
    // User can only see group "Public"
    const publicGroup: Group = {
      id: 'g-public',
      name: 'Public',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [],
    }

    // Backend returned device with group_id: null (or group_id for a group outside user's grants)
    const devices: FleetMapDevice[] = [
      makeDevice('d-pub', 'Public-PC', 'g-public', 'online'),
      makeDevice('d-hidden', 'Secret-PC', null, 'online'),
      makeDevice('d-outside', 'Outside-PC', 'g-forbidden-outside-grants', 'offline'),
    ]

    const { topLevelRows } = buildFleetTree([publicGroup], devices)
    expect(topLevelRows).toHaveLength(2)

    expect(topLevelRows[0]!.name).toBe('Public')
    expect(topLevelRows[0]!.total).toBe(1)

    expect(topLevelRows[1]!.name).toBe('Ungrouped')
    expect(topLevelRows[1]!.total).toBe(2)
    expect(topLevelRows[1]!.allDevices.map((d) => d.name)).toEqual(['Outside-PC', 'Secret-PC'])
  })

  it('omits Ungrouped row when there are no ungrouped devices', () => {
    const g: Group = {
      id: 'g1',
      name: 'Main',
      parent_id: null,
      policy_id: null,
      effective_policy_id: 'p1',
      children: [],
    }
    const devices = [makeDevice('d1', 'PC-01', 'g1', 'online')]
    const { topLevelRows } = buildFleetTree([g], devices)
    expect(topLevelRows).toHaveLength(1)
    expect(topLevelRows[0]!.name).toBe('Main')
  })
})

describe('shouldCollapseToBar', () => {
  it('collapses to bar when nodes exceed line limits', () => {
    // nodeWidth = 24, gap = 8 => 32px per node
    // availableWidth = 320px
    // nodesPerLine = Math.floor((320 + 8) / 32) = 10 nodes per line
    const availableWidth = 320

    // Medium: maxLines = 2 => max 20 nodes
    expect(
      shouldCollapseToBar({ deviceCount: 20, availableWidth, maxLines: 2, nodeWidth: 24, gap: 8 }),
    ).toBe(false)
    expect(
      shouldCollapseToBar({ deviceCount: 21, availableWidth, maxLines: 2, nodeWidth: 24, gap: 8 }),
    ).toBe(true)

    // Large: maxLines = 4 => max 40 nodes
    expect(
      shouldCollapseToBar({ deviceCount: 40, availableWidth, maxLines: 4, nodeWidth: 24, gap: 8 }),
    ).toBe(false)
    expect(
      shouldCollapseToBar({ deviceCount: 41, availableWidth, maxLines: 4, nodeWidth: 24, gap: 8 }),
    ).toBe(true)
  })

  it('returns false when deviceCount is 0 or width is invalid', () => {
    expect(shouldCollapseToBar({ deviceCount: 0, availableWidth: 320, maxLines: 2 })).toBe(false)
    expect(shouldCollapseToBar({ deviceCount: 10, availableWidth: 0, maxLines: 2 })).toBe(false)
  })
})

describe('filterWallRows', () => {
  it('sorts problem groups first, then alphabetically, and cuts off healthy groups with +N healthy groups', () => {
    const makeRow = (name: string, alertCount: number, offlineCount: number) => ({
      id: name,
      name,
      depth: 0,
      children: [],
      directDevices: [],
      allDevices: [],
      total: alertCount + offlineCount + 5,
      online: 5 + alertCount,
      onlineClean: 5,
      alertCount,
      offlineCount,
      hasSubgroups: false,
    })

    const rows = [
      makeRow('Healthy Zebra', 0, 0),
      makeRow('Problem Alert', 1, 0),
      makeRow('Healthy Alpha', 0, 0),
      makeRow('Problem Offline', 0, 2),
      makeRow('Healthy Beta', 0, 0),
      makeRow('Healthy Gamma', 0, 0),
    ]

    // Total rows: 6 (2 problem rows: Problem Alert, Problem Offline; 4 healthy rows: Alpha, Beta, Gamma, Zebra)
    // When maxRows = 4:
    // Problem Alert, Problem Offline take 2 slots
    // Healthy Alpha takes 1 slot
    // Slot 4 is reserved for "+3 healthy groups" (Beta, Gamma, Zebra)
    const result = filterWallRows(rows, 4)
    expect(result.visibleRows.map((r) => r.name)).toEqual([
      'Problem Alert',
      'Problem Offline',
      'Healthy Alpha',
    ])
    expect(result.hiddenHealthyCount).toBe(3)
  })

  it('never hides problem groups before healthy groups', () => {
    const makeRow = (name: string, alertCount: number) => ({
      id: name,
      name,
      depth: 0,
      children: [],
      directDevices: [],
      allDevices: [],
      total: 5,
      online: 5,
      onlineClean: 5,
      alertCount,
      offlineCount: 0,
      hasSubgroups: false,
    })

    const rows = [
      makeRow('Healthy 1', 0),
      makeRow('Problem 1', 1),
      makeRow('Problem 2', 1),
      makeRow('Problem 3', 1),
    ]

    const result = filterWallRows(rows, 3)
    // 3 problem rows fill all 3 slots
    expect(result.visibleRows.map((r) => r.name)).toEqual(['Problem 1', 'Problem 2', 'Problem 3'])
    expect(result.hiddenHealthyCount).toBe(1)
  })
})

describe('formatting helpers', () => {
  it('formats header badge text omitting zero parts', () => {
    expect(formatHeaderBadgeText({ total: 55, offline: 3, alert: 1 })).toBe(
      '55 devices · 3 offline · 1 alert',
    )
    expect(formatHeaderBadgeText({ total: 10, offline: 0, alert: 0 })).toBe('10 devices')
    expect(formatHeaderBadgeText({ total: 10, offline: 2, alert: 0 })).toBe(
      '10 devices · 2 offline',
    )
  })

  it('formats compact header badge text for narrow screens omitting zero parts', () => {
    expect(formatCompactHeaderBadgeText({ total: 28, offline: 8, alert: 3 })).toBe(
      '28 · 8 off · 3 ⚠',
    )
    expect(formatCompactHeaderBadgeText({ total: 10, offline: 0, alert: 0 })).toBe('10')
    expect(formatCompactHeaderBadgeText({ total: 10, offline: 2, alert: 0 })).toBe('10 · 2 off')
    expect(formatCompactHeaderBadgeText({ total: 10, offline: 0, alert: 4 })).toBe('10 · 4 ⚠')
  })

  it('formats status bar accessible text', () => {
    expect(formatBarAccessibleText({ alert: 2, offline: 3, online: 38 })).toBe(
      '2 alert, 3 offline, 38 online',
    )
    expect(formatBarAccessibleText({ alert: 0, offline: 1, online: 5 })).toBe('1 offline, 5 online')
    expect(formatBarAccessibleText({ alert: 0, offline: 0, online: 10 })).toBe('10 online')
  })

  it('formats compact status bar text for narrow screens showing only non-zero problem counts or online', () => {
    expect(formatCompactBarText({ alert: 2, offline: 30, online: 45 })).toBe('2⚠ 30 off')
    expect(formatCompactBarText({ alert: 4, offline: 0, online: 10 })).toBe('4⚠')
    expect(formatCompactBarText({ alert: 0, offline: 8, online: 16 })).toBe('8 off')
    expect(formatCompactBarText({ alert: 0, offline: 0, online: 24 })).toBe('24 online')
  })
})
