import * as React from 'react'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, SearchIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Group } from './group-utils'

/** Every group's path from the root, e.g. "Test 1 / Sub1". */
export function groupPaths(groups: Group[]): Map<string, string> {
  const paths = new Map<string, string>()
  const visit = (list: Group[], prefix: string) => {
    for (const group of list) {
      const path = prefix ? `${prefix} / ${group.name}` : group.name
      paths.set(group.id, path)
      visit(group.children ?? [], path)
    }
  }
  visit(groups, '')
  return paths
}

interface TreeRow {
  group: Group
  depth: number
  hasChildren: boolean
  parentId: string | null
}

/** The groups in tree order, leaving out everything below a collapsed group. */
function visibleRows(groups: Group[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const visit = (list: Group[], depth: number, parentId: string | null) => {
    for (const group of list) {
      const children = group.children ?? []
      rows.push({ group, depth, hasChildren: children.length > 0, parentId })
      if (children.length > 0 && expanded.has(group.id)) visit(children, depth + 1, group.id)
    }
  }
  visit(groups, 0, null)
  return rows
}

/** Ids of the groups that have subgroups. */
function parentIds(groups: Group[]): Set<string> {
  const ids = new Set<string>()
  const visit = (list: Group[]) => {
    for (const group of list) {
      if (group.children?.length) {
        ids.add(group.id)
        visit(group.children)
      }
    }
  }
  visit(groups)
  return ids
}

/** Ids of the groups that have a descendant in `marked`. */
function ancestorsOf(groups: Group[], marked: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>()
  const visit = (group: Group): boolean => {
    let found = false
    for (const child of group.children ?? []) {
      if (visit(child) || marked.has(child.id)) found = true
    }
    if (found) ids.add(group.id)
    return found
  }
  for (const group of groups) visit(group)
  return ids
}

function toggledSet(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

const indent = (depth: number) => `${0.5 + depth * 1.25}rem`

function ExpandToggle({
  name,
  expanded,
  onToggle,
  keepFocus = false,
}: {
  name: string
  expanded: boolean
  onToggle: () => void
  /** In the picker, focus stays in the search box. */
  keepFocus?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
      aria-expanded={expanded}
      tabIndex={keepFocus ? -1 : undefined}
      onMouseDown={keepFocus ? (event) => event.preventDefault() : undefined}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
    >
      {expanded ? (
        <ChevronDownIcon className="size-4" aria-hidden="true" />
      ) : (
        <ChevronRightIcon className="size-4" aria-hidden="true" />
      )}
    </button>
  )
}

const checkboxClass = 'size-4 shrink-0 rounded border-border accent-primary disabled:opacity-60'

export interface GroupCheckTreeProps {
  groups: Group[]
  checkedIds: ReadonlySet<string>
  /** Groups under a checked group: shown checked and disabled. */
  coveredIds: ReadonlySet<string>
  onToggle: (id: string, checked: boolean) => void
}

/**
 * The checkbox tree. Groups start collapsed, except those holding a checked or
 * covered group, so saved choices are visible.
 */
export function GroupCheckTree({ groups, checkedIds, coveredIds, onToggle }: GroupCheckTreeProps) {
  const uid = React.useId()
  const [expanded, setExpanded] = React.useState<Set<string>>(() =>
    ancestorsOf(groups, new Set([...checkedIds, ...coveredIds])),
  )
  const rows = visibleRows(groups, expanded)
  return (
    <ul className="flex max-h-52 flex-col overflow-y-auto rounded-lg border border-border">
      {rows.map(({ group, depth, hasChildren }) => {
        const isCovered = coveredIds.has(group.id)
        const coveredId = `${uid}-covered-${group.id}`
        return (
          <li
            key={group.id}
            style={{ paddingLeft: indent(depth) }}
            className="py-1 pr-3 pointer-coarse:py-0"
          >
            <div className="flex min-h-7 items-center gap-1.5 pointer-coarse:min-h-11">
              {hasChildren ? (
                <ExpandToggle
                  name={group.name}
                  expanded={expanded.has(group.id)}
                  onToggle={() => setExpanded((prev) => toggledSet(prev, group.id))}
                />
              ) : (
                <span className="size-5 shrink-0 pointer-coarse:size-11" aria-hidden="true" />
              )}
              <label className="inline-flex min-w-0 flex-1 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  checked={isCovered || checkedIds.has(group.id)}
                  disabled={isCovered}
                  aria-describedby={isCovered ? coveredId : undefined}
                  onChange={(event) => onToggle(group.id, event.target.checked)}
                />
                <span className="truncate">{group.name}</span>
              </label>
              {isCovered && (
                <span
                  id={coveredId}
                  className="ml-auto max-w-[45%] truncate text-xs text-muted-foreground"
                >
                  covered by a parent group
                </span>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

interface PickerRow {
  /** 'none' or the group id */
  key: string
  id: string | null
  /** The accessible name. */
  label: string
  /** The shown text: the name in the tree, the path in search results. */
  text: string
  depth: number
  hasChildren: boolean
  parentKey: string | null
}

export interface GroupPickerProps {
  groups: Group[]
  value: string | null
  onChange: (id: string | null) => void
  /** The first row, standing for no group ("No group", "All groups"). */
  noneLabel: string
  id?: string
  ariaLabel?: string
  /** One line under the search box. */
  hint?: string
  /** Optional choice inserted after the empty row. */
  ungroupedOption?: string
  /** Value used for the optional choice; defaults to 'ungrouped'. */
  ungroupedValue?: string
  className?: string
}

/** A popover with the group tree (everything expanded on open) and a search box. */
export function GroupPicker({
  groups,
  value,
  onChange,
  noneLabel,
  id,
  ariaLabel,
  hint,
  ungroupedOption,
  ungroupedValue = 'ungrouped',
  className,
}: GroupPickerProps) {
  const [open, setOpen] = React.useState(false)
  const paths = React.useMemo(() => groupPaths(groups), [groups])
  const selectedPath =
    value === ungroupedValue && ungroupedOption
      ? ungroupedOption
      : value
        ? (paths.get(value) ?? null)
        : null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          aria-label={ariaLabel}
          data-slot="group-picker-trigger"
          className={cn(
            'flex h-[var(--control-height,2.25rem)] w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground shadow-xs ring-offset-background focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-1',
            className,
          )}
        >
          <span className="truncate">{selectedPath ?? noneLabel}</span>
          <ChevronDownIcon className="size-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[max(16rem,var(--radix-popover-trigger-width))] p-0"
      >
        <PickerBody
          groups={groups}
          paths={paths}
          value={value}
          noneLabel={noneLabel}
          ungroupedOption={ungroupedOption}
          ungroupedValue={ungroupedValue}
          hint={hint}
          onSelect={(next) => {
            onChange(next)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function PickerBody({
  groups,
  paths,
  value,
  noneLabel,
  ungroupedOption,
  ungroupedValue,
  hint,
  onSelect,
}: {
  groups: Group[]
  paths: Map<string, string>
  value: string | null
  noneLabel: string
  ungroupedOption?: string
  ungroupedValue: string
  hint?: string
  onSelect: (id: string | null) => void
}) {
  const uid = React.useId()
  const [query, setQuery] = React.useState('')
  const [expanded, setExpanded] = React.useState<Set<string>>(() => parentIds(groups))
  const [activeKey, setActiveKey] = React.useState(value ?? 'none')
  const searching = query.trim() !== ''

  const rows = React.useMemo<PickerRow[]>(() => {
    if (searching) {
      const needle = query.trim().toLowerCase()
      const found: PickerRow[] = []
      const visit = (list: Group[]) => {
        for (const group of list) {
          if (group.name.toLowerCase().includes(needle)) {
            const path = paths.get(group.id) ?? group.name
            found.push({
              key: group.id,
              id: group.id,
              label: path,
              text: path,
              depth: 0,
              hasChildren: false,
              parentKey: null,
            })
          }
          visit(group.children ?? [])
        }
      }
      visit(groups)
      return found
    }
    return [
      {
        key: 'none',
        id: null,
        label: noneLabel,
        text: noneLabel,
        depth: 0,
        hasChildren: false,
        parentKey: null,
      },
      ...(ungroupedOption
        ? [
            {
              key: ungroupedValue,
              id: ungroupedValue,
              label: ungroupedOption,
              text: ungroupedOption,
              depth: 0,
              hasChildren: false,
              parentKey: null,
            } satisfies PickerRow,
          ]
        : []),
      ...visibleRows(groups, expanded).map(
        ({ group, depth, hasChildren, parentId }): PickerRow => ({
          key: group.id,
          id: group.id,
          label: group.name,
          text: group.name,
          depth,
          hasChildren,
          parentKey: parentId,
        }),
      ),
    ]
  }, [groups, paths, expanded, searching, query, noneLabel, ungroupedOption, ungroupedValue])

  const found = rows.findIndex((row) => row.key === activeKey)
  const activeIndex = found === -1 ? 0 : found
  const active = rows[activeIndex]
  const rowId = (key: string) => `${uid}-${key}`

  const activeRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active?.key])

  const move = (index: number) => {
    const row = rows[Math.min(rows.length - 1, Math.max(0, index))]
    if (row) setActiveKey(row.key)
  }
  const toggle = (key: string) => setExpanded((prev) => toggledSet(prev, key))

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(activeIndex + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(activeIndex - 1)
        break
      case 'Home':
        event.preventDefault()
        move(0)
        break
      case 'End':
        event.preventDefault()
        move(rows.length - 1)
        break
      case 'ArrowRight':
        // In the search box the arrows edit the text; they walk the tree only when it is shown.
        if (searching || !active) break
        event.preventDefault()
        if (active.hasChildren) {
          if (!expanded.has(active.key)) toggle(active.key)
          else move(activeIndex + 1)
        }
        break
      case 'ArrowLeft':
        if (searching || !active) break
        event.preventDefault()
        if (active.hasChildren && expanded.has(active.key)) toggle(active.key)
        else if (active.parentKey) setActiveKey(active.parentKey)
        break
      case 'Enter':
        event.preventDefault()
        if (active) onSelect(active.id)
        break
    }
  }

  return (
    <div className="flex flex-col" data-slot="group-picker">
      <div className="flex flex-col gap-1 border-b border-border px-3 py-2">
        <div className="flex items-center">
          <SearchIcon className="mr-2 size-4 shrink-0 opacity-50" aria-hidden="true" />
          <input
            type="text"
            role="combobox"
            aria-label="Search groups"
            aria-expanded="true"
            aria-haspopup="tree"
            aria-controls={rows.length > 0 ? `${uid}-tree` : undefined}
            aria-activedescendant={active ? rowId(active.key) : undefined}
            autoComplete="off"
            placeholder="Search groups"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            className="h-8 w-full bg-transparent text-sm text-foreground outline-hidden placeholder:text-muted-foreground"
          />
        </div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">No groups match.</p>
      ) : (
        <div
          role="tree"
          id={`${uid}-tree`}
          aria-label="Groups"
          className="max-h-64 overflow-y-auto p-1"
        >
          {rows.map((row) => {
            const isActive = row.key === active?.key
            const isSelected = row.id === value
            return (
              <div
                key={row.key}
                id={rowId(row.key)}
                ref={isActive ? activeRef : undefined}
                role="treeitem"
                aria-label={row.label}
                aria-level={row.depth + 1}
                aria-selected={isSelected}
                aria-expanded={row.hasChildren ? expanded.has(row.key) : undefined}
                data-active={isActive || undefined}
                style={{ paddingLeft: indent(row.depth) }}
                onClick={() => onSelect(row.id)}
                onMouseMove={() => {
                  if (!isActive) setActiveKey(row.key)
                }}
                className={cn(
                  'flex min-h-8 cursor-pointer items-center gap-1 rounded-sm py-1 pr-2 text-sm pointer-coarse:min-h-11',
                  isActive && 'bg-accent text-accent-foreground',
                )}
              >
                {row.hasChildren ? (
                  <ExpandToggle
                    name={row.label}
                    expanded={expanded.has(row.key)}
                    onToggle={() => toggle(row.key)}
                    keepFocus
                  />
                ) : (
                  <span className="size-5 shrink-0 pointer-coarse:size-11" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate">{row.text}</span>
                {isSelected && <CheckIcon className="size-4 shrink-0" aria-hidden="true" />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
