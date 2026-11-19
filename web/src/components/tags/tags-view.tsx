import * as React from 'react'
import { PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { EmptyState } from '@/components/brand/empty-state'
import { ErrorState } from '@/components/brand/error-state'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toCss } from '@/lib/tagColor'
import { useAllTags, type Tag } from '@/lib/tags'
import { TagDeleteDialog, TagFormDialog } from './tag-dialogs'
import { TagPill } from './tag-pill'

export function TagsView() {
  const [formOpen, setFormOpen] = React.useState(false)
  const [editingTag, setEditingTag] = React.useState<Tag | null>(null)

  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deletingTag, setDeletingTag] = React.useState<Tag | null>(null)

  const tagsQuery = useAllTags()
  const tags = tagsQuery.data ?? []

  const handleCreate = () => {
    setEditingTag(null)
    setFormOpen(true)
  }

  const handleEdit = (tag: Tag) => {
    setEditingTag(tag)
    setFormOpen(true)
  }

  const handleDelete = (tag: Tag) => {
    setDeletingTag(tag)
    setDeleteOpen(true)
  }

  return (
    <div className="flex flex-col gap-6 w-full p-0 sm:p-6" data-slot="tags-page">
      <PageHeader
        title="Tags"
        description="Label and color-code devices for rapid categorization, filtering, and bulk management."
        actions={
          <Button
            onClick={handleCreate}
            size="sm"
            className="gap-1.5 min-h-[44px] sm:min-h-0 h-11 sm:h-8"
          >
            <PlusIcon className="size-4" />
            <span>New tag</span>
          </Button>
        }
      />

      {/* Main Content */}
      {tagsQuery.isLoading ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : tagsQuery.isError ? (
        <ErrorState error={tagsQuery.error} retry={() => void tagsQuery.refetch()} />
      ) : tags.length === 0 ? (
        <EmptyState
          title="No tags created yet"
          description="Create tags to colorfully organize and filter your devices across the fleet."
          action={
            <Button
              onClick={handleCreate}
              size="sm"
              className="gap-1.5 min-h-[44px] sm:min-h-0 h-11 sm:h-8"
            >
              <PlusIcon className="size-4" />
              <span>Create first tag</span>
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border border-border bg-card shadow-xs overflow-hidden">
          <Table className="block sm:table">
            <TableHeader className="hidden sm:table-header-group">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-1/3">Tag preview</TableHead>
                <TableHead>Color code</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="block sm:table-row-group divide-y divide-border/60 sm:divide-y">
              {tags.map((tag) => (
                <TableRow
                  key={tag.id}
                  data-slot="tag-row"
                  data-tag-id={tag.id}
                  className="flex items-center justify-between p-3 gap-2 sm:table-row sm:p-0"
                >
                  <TableCell className="p-0 sm:px-4 sm:py-3 block sm:table-cell flex-1 min-w-0">
                    <div className="flex flex-col items-start sm:flex-row sm:items-center gap-1 sm:gap-2 min-w-0">
                      <TagPill name={tag.name} color={tag.color} className="max-w-full" />
                      <span className="sm:hidden font-mono text-2xs text-muted-foreground uppercase">
                        {toCss(tag.color)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="font-mono text-xs text-muted-foreground uppercase">
                      {toCss(tag.color)}
                    </span>
                  </TableCell>
                  <TableCell className="p-0 sm:px-4 sm:py-3 block sm:table-cell text-right shrink-0">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEdit(tag)}
                        className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 h-11 sm:h-8 px-3 sm:px-2 text-xs gap-1.5 sm:gap-1 text-muted-foreground hover:text-foreground"
                        aria-label={`Edit tag ${tag.name}`}
                      >
                        <PencilIcon className="size-4 sm:size-3.5" />
                        <span>Edit</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(tag)}
                        className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 h-11 sm:h-8 px-3 sm:px-2 text-xs gap-1.5 sm:gap-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        aria-label={`Delete tag ${tag.name}`}
                      >
                        <Trash2Icon className="size-4 sm:size-3.5" />
                        <span>Delete</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Dialogs */}
      <TagFormDialog tag={editingTag} open={formOpen} onOpenChange={setFormOpen} />

      <TagDeleteDialog tag={deletingTag} open={deleteOpen} onOpenChange={setDeleteOpen} />
    </div>
  )
}
