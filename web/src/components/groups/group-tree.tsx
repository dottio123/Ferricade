import * as React from 'react'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
  MoveIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Group } from './group-utils'

export interface GroupStatsMap {
  [groupId: string]: { online: number; total: number }
}

export interface GroupTreeNodeProps {
  group: Group
  level: number
  stats?: { online: number; total: number }
  statsMap: GroupStatsMap
  onAddSubgroup: (parent: Group) => void
  onRename: (group: Group) => void
  onMove: (group: Group) => void
  onDelete: (group: Group) => void
}

export function GroupTreeNode({
  group,
  level,
  stats,
  statsMap,
  onAddSubgroup,
  onRename,
  onMove,
  onDelete,
}: GroupTreeNodeProps) {
  const [expanded, setExpanded] = React.useState(true)
  const hasChildren = Boolean(group.children && group.children.length > 0)

  const phoneIndentRem =
    level <= 0 ? 0.5 : level === 1 ? 1.5 : level === 2 ? 2.25 : level === 3 ? 2.75 : 3.0
  const desktopIndentRem = Math.max(0.5, level * 1.5)

  return (
    <div className="flex flex-col select-none" data-slot="group-node" data-group-id={group.id}>
      <div
        style={
          {
            '--phone-indent': `${phoneIndentRem}rem`,
            '--desktop-indent': `${desktopIndentRem}rem`,
          } as React.CSSProperties
        }
        className="flex items-center justify-between rounded-md p-2 transition-colors hover:bg-muted/40 group gap-1.5 sm:gap-2 [padding-left:var(--phone-indent)] sm:[padding-left:var(--desktop-indent)]"
      >
        {/* Left: toggle + folder + name + count */}
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              aria-label={expanded ? 'Collapse group' : 'Expand group'}
              className="text-muted-foreground hover:text-foreground rounded focus-visible:outline-hidden size-9 sm:size-5 inline-flex items-center justify-center shrink-0"
            >
              {expanded ? (
                <ChevronDownIcon className="size-4 shrink-0" />
              ) : (
                <ChevronRightIcon className="size-4 shrink-0" />
              )}
            </button>
          ) : (
            <span
              className="size-9 sm:size-5 shrink-0"
              aria-hidden="true"
              data-slot="group-leaf-spacer"
            />
          )}

          <FolderIcon className="size-4 text-muted-foreground shrink-0" />

          <span
            className="text-sm font-medium text-foreground truncate min-w-0"
            data-slot="group-name"
            title={group.name}
          >
            {group.name}
          </span>

          {stats !== undefined && (
            <Badge
              variant="secondary"
              className="text-2xs h-5 px-1.5 font-normal ml-1 shrink-0 whitespace-nowrap"
            >
              <span className="font-semibold text-foreground">{stats.online}</span>
              <span className="text-muted-foreground mx-0.5">/</span>
              <span>{stats.total} online</span>
            </Badge>
          )}
        </div>

        {/* Right: Actions menu */}
        <div className="flex items-center gap-1 opacity-90 group-hover:opacity-100 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 h-11 w-11 sm:h-7 sm:w-7 p-0 text-muted-foreground hover:text-foreground"
                aria-label={`Actions for group ${group.name}`}
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => onAddSubgroup(group)}>
                <FolderPlusIcon className="size-4 mr-2" />
                Add subgroup
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRename(group)}>
                <PencilIcon className="size-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onMove(group)}>
                <MoveIcon className="size-4 mr-2" />
                Move to…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(group)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2Icon className="size-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Render children if expanded */}
      {hasChildren && expanded && (
        <div className="flex flex-col">
          {group.children.map((child) => (
            <GroupTreeNode
              key={child.id}
              group={child}
              level={level + 1}
              stats={statsMap[child.id]}
              statsMap={statsMap}
              onAddSubgroup={onAddSubgroup}
              onRename={onRename}
              onMove={onMove}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}
