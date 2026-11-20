# Fleet overview rework: groups with device nodes

Status: approved by the user in chat, 2026-10-23 (Project Lead 10). Target: rdadmin 1.9.0.

## Problem

The dashboard module "Fleet overview" (`web/src/features/dashboard/modules/fleet-overview.tsx`) has two modes:

- Up to 30 approved devices: one chip per device ("nodes").
- More than 30: a flat list of groups from `GET /stats/summary` → `groups`, each with its **own** devices only.

In the second mode a parent whose devices all sit in subgroups shows `0 / 0 online (0%)` (JCC, SIA); rows are not
clickable; the list overflows the card (the fit is a guess of 42 px per row) and cannot be scrolled; status is only
online/total, so offline, alert and pending cannot be told apart.

## Goal (user's answers)

- Main job: **both, by group**: groups as rows, each group's devices drawn as nodes inside the row; a group too big
  for nodes collapses to a summary.
- Hierarchy: **top-level groups, expandable** into their subgroups; counts include subgroups.
- Scale: handle **up to ~500** approved devices well; degrade gracefully above.

## Design

### Rows (medium and large sizes)

```
┌ Fleet overview ─────────────── 55 devices · 3 offline · 1 alert ─ View all ┐
│ ▸ IT Devices        4/4   ■■■■                                              │
│ ▾ JCC               0/0   no devices                                        │
│     Aquatics        0/0   —                                                 │
│ ▾ SIA              43/43  ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■      │
│     Administration 11/11  ■■■■■■■■■■■                                       │
│   Ungrouped         7/8   ▲■■■■■■□                                          │
└───────────────────────────────────────────── (body scrolls inside the card) ┘
```

- One row per **top-level** group, by name (case-insensitive), "Ungrouped" last (only when it has devices).
- A row shows: expand chevron (only with subgroups), group name, `online/total` **including all descendants**, and the
  group's devices as nodes.
- Expanding shows the direct subgroups as indented rows, each rolled up over its own descendants, recursively
  expandable. Expanded state is per browser (localStorage, per user id), default all collapsed.
- **Nodes:** one square per device, colour by status (`alert`, `offline`, `online`; alert also carries the existing
  glyph), ordered alert → offline → online, then by name. Tooltip = name + status; click opens the device panel
  (`DeviceLink`, as today). Nodes of a collapsed row are all devices of the group and its descendants; nodes of an
  expanded parent row are only its own (direct) devices, its subgroups show theirs.
- **Collapse to a bar:** when a row's nodes need more than **2 lines** (medium) or **4 lines** (large) at the current
  width, the row shows a proportional status bar `alert | offline | online` with the counts instead of nodes.
- A group with no devices shows "no devices" (top level) or "—" (subgroup); empty groups stay listed so the tree
  matches the Groups page.
- The module body **scrolls inside the card** (`overflow-y: auto`, the card keeps its grid size); no measuring of how
  many items fit.
- Header badge: `{total} devices · {offline} offline · {alert} alert` (zero parts omitted).
- Group name is a link to `/devices?group=<id>&subgroups=true` (Devices filtered to the group and its subgroups);
  "Ungrouped" links to `/devices?group=ungrouped`. "View all" stays.

### Small size (2×2)

No nodes: one line per top-level group (name, `online/total`, slim status bar), scrolling; totals in the header badge.
Expanding works as in medium.

### Wall display (`isWall`)

Top-level rows only, no chevrons, no links, larger nodes; rows with alert or offline devices first, then by name. The
body does not scroll: rows that do not fit are replaced by one last line "+N healthy groups" (never hiding a group with
problems before a healthy one).

### Data

New read-only endpoint (contract first):

`GET /admin/api/v1/stats/fleet-map` → `200`
```json
{"generated_at":"2026-10-23T12:00:00Z","truncated":false,
 "devices":[{"id":"…","name":"FRONTDESK-01","group_id":"…","status":"offline"}]}
```
- Every **approved** device the caller can see, at most **2000**, ordered by name (case-insensitive) then id;
  `truncated` is true when more exist (the widget then shows bars only and says "Showing 2000 of N" in the badge
  tooltip, N from the summary).
- `name` = alias, else hostname, else rustdesk_id (the UI's `deviceName()`).
- `status`: `alert` if the device has any open alert; else `online`/`offline` from the online tracker. (Approved
  devices are never pending.)
- `group_id`: the device's group, or `null`; **for a User**, `null` when the group is outside their grants (the same
  rule as `GET /devices/{id}` and the `ungrouped` filter), so hidden group names and structure never leak.
- Auth: any signed-in role (Owner, Admin, User: visible devices only). Not audited (read).
- The widget builds the tree from the existing `GET /groups` (a User gets only their groups) and rolls counts up
  client-side.

Device list option (contract addition, with the Devices page using it):

`GET /admin/api/v1/devices?group=<id>&subgroups=true` → the group and all its descendants. `subgroups` without
`group`, or with `ungrouped=true`, → 400 `bad_request`. For a User, only descendants within their grants count. The
Devices page keeps `subgroups=true` in its URL and shows it as part of the group filter chip ("JCC and subgroups"),
with a checkbox "Include subgroups" under the group filter.

### Live updates

The fleet map has its own query key; `device.online`, `device.offline`, `device.updated`, `device.enrolled`,
`device.deleted` and `resync` invalidate it through the existing debounced live-update path, as the summary is today.
`group_rules.updated` and group changes refetch `GET /groups` as today.

### States

Loading: 4 skeleton rows. Error: the module's standard error with retry. No approved devices: "No approved devices in
fleet" (unchanged).

### Removed

The 30-device switch between chips and group bars, `sortByUrgency`/measuring code that only served it, and the hidden
measuring container. Keep `statusSquareGlyph` if reused.

## Accessibility

Rows are a nested list (`<ul>`/`<li>`) with disclosure buttons, not an ARIA tree: each chevron is a `<button>` with
`aria-expanded` and the name "Expand JCC"/"Collapse JCC", controlling its subgroup list (`aria-controls`); each node is a link named
"{name}, {status}"; the bar has an accessible text equivalent ("2 alert, 3 offline, 38 online"); colour is never the
only signal (alert glyph, counts).

## Testing

- Go (real Postgres): fleet-map content, status mapping (alert beats online), order, the 2000 cap and `truncated`,
  User scoping (hidden group → `group_id` null; invisible devices absent); `subgroups=true` on a three-level tree, the
  400 combinations, User scoping.
- Mock: same rules; mock tests.
- Vitest: roll-up over a three-level tree; node order; collapse-to-bar threshold (mock the measured width); expand
  state persisted; wall ordering and "+N healthy groups"; User sees hidden-group devices under Ungrouped.
- Playwright (Codex): medium dashboard with the mock fleet: no overflow outside the card, body scrolls, expanding a
  parent shows its subgroups, clicking a node opens the device panel, clicking a group name lands on the filtered
  Devices page.

## Out of scope

Pending devices in the widget (the approval queue module covers them), per-group policy display, drag and drop,
sorting options in the widget, fleets above 2000 devices with nodes.

## Tasks (Lead)

1. Codex: `GET /stats/fleet-map` (contract, Go, mock, tests).
2. Codex: `subgroups=true` on the device list + the Devices page checkbox/chip (after the device-list sort work, same
   query).
3. Gemini (Impeccable): rebuild the module per this spec against the mock.
4. Codex: Playwright spec for the module.
