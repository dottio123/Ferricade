import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { describeError } from '@/api/errors'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { queryKeys } from '@/lib/queryKeys'
import { fromCss, toCss } from '@/lib/tagColor'
import type { Tag } from '@/lib/tags'
import { TagPill } from './tag-pill'

const SWATCH_PALETTE = [
  { label: 'Blue', hex: '#2196f3' },
  { label: 'Green', hex: '#4caf50' },
  { label: 'Orange', hex: '#ff9800' },
  { label: 'Purple', hex: '#9c27b0' },
  { label: 'Teal', hex: '#009688' },
  { label: 'Brown', hex: '#795548' },
  { label: 'Pink', hex: '#e91e63' },
  { label: 'Indigo', hex: '#3f51b5' },
  { label: 'Red', hex: '#f44336' },
  { label: 'Slate', hex: '#607d8b' },
]

function mapTagError(err: unknown): string {
  const { code, message } = describeError(err)
  if (code === 'name_taken') {
    return 'A tag with this name already exists.'
  }
  return message
}

function useInvalidateTags() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tags.all() })
    void queryClient.invalidateQueries({ queryKey: queryKeys.devices.all() })
  }
}

// -------------------------------------------------------------
// TagFormDialog (Create & Edit)
// -------------------------------------------------------------
export interface TagFormDialogProps {
  tag?: Tag | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (tag: Tag) => void
}

function TagForm({
  tag,
  onClose,
  onCreated,
}: {
  tag?: Tag | null
  onClose: () => void
  onCreated?: (tag: Tag) => void
}) {
  const [name, setName] = React.useState(tag?.name ?? '')
  const [hexColor, setHexColor] = React.useState(tag ? toCss(tag.color) : '#2196f3')
  const [error, setError] = React.useState<string | null>(null)
  const invalidate = useInvalidateTags()
  const { toast } = useToast()

  const saveMutation = useMutation({
    mutationFn: async () => {
      const colorNum = fromCss(hexColor)
      const trimmed = name.trim()
      if (tag) {
        return unwrap(
          api.PATCH('/admin/api/v1/tags/{id}', {
            params: { path: { id: tag.id } },
            body: { name: trimmed, color: colorNum },
          }),
        )
      } else {
        return unwrap(
          api.POST('/admin/api/v1/tags', {
            body: { name: trimmed, color: colorNum },
          }),
        )
      }
    },
    onSuccess: (data) => {
      invalidate()
      toast({ title: tag ? 'Tag saved' : 'Tag created' })
      if (!tag) onCreated?.(data)
      onClose()
    },
    onError: (err) => {
      setError(mapTagError(err))
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setError(null)
    saveMutation.mutate()
  }

  const currentColorNum = fromCss(hexColor)

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tag ? 'Edit tag' : 'Create new tag'}</DialogTitle>
        <DialogDescription>
          {tag
            ? 'Change the name or color of this tag.'
            : 'Add a new tag to label and filter devices.'}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="tag-name-input" className="text-xs font-medium text-muted-foreground">
            Tag name
          </label>
          <Input
            id="tag-name-input"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'tag-form-error' : undefined}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Production"
            maxLength={64}
            required
            autoFocus
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">Color</span>

          {/* Swatch palette */}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Tag color swatches">
            {SWATCH_PALETTE.map((swatch) => (
              <button
                key={swatch.hex}
                type="button"
                aria-label={swatch.label}
                onClick={() => setHexColor(swatch.hex)}
                className={`size-7 rounded-full border transition-all ${
                  hexColor.toLowerCase() === swatch.hex.toLowerCase()
                    ? 'ring-2 ring-primary ring-offset-2 border-foreground'
                    : 'border-border/60 hover:scale-110'
                }`}
                style={{ backgroundColor: swatch.hex }}
              />
            ))}
          </div>

          {/* Hex input & live preview */}
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <div className="w-32">
              <label htmlFor="tag-hex-input" className="sr-only">
                Hex color
              </label>
              <Input
                id="tag-hex-input"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'tag-form-error' : undefined}
                aria-label="Hex color"
                value={hexColor}
                onChange={(e) => setHexColor(e.target.value)}
                placeholder="#2196f3"
                className="font-mono text-xs uppercase"
                maxLength={7}
              />
            </div>

            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="text-xs text-muted-foreground shrink-0">Preview:</span>
              <TagPill name={name.trim() || 'Sample tag'} color={currentColorNum} />
            </div>
          </div>
        </div>

        {error && (
          <p id="tag-form-error" role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saveMutation.isPending}
            className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!name.trim() || saveMutation.isPending}
            className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
          >
            {saveMutation.isPending ? 'Saving…' : tag ? 'Save changes' : 'Create tag'}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

export function TagFormDialog({ tag, open, onOpenChange, onCreated }: TagFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="tag-form-dialog" className="max-h-[90vh] overflow-y-auto">
        {open && <TagForm tag={tag} onClose={() => onOpenChange(false)} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  )
}

// -------------------------------------------------------------
// TagDeleteDialog
// -------------------------------------------------------------
export interface TagDeleteDialogProps {
  tag: Tag | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

function DeleteTagForm({ tag, onClose }: { tag: Tag; onClose: () => void }) {
  const [error, setError] = React.useState<string | null>(null)
  const invalidate = useInvalidateTags()

  const deleteMutation = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/admin/api/v1/tags/{id}', {
          params: { path: { id: tag.id } },
        }),
      ),
    onSuccess: () => {
      invalidate()
      onClose()
    },
    onError: (err) => {
      setError(mapTagError(err))
    },
  })

  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete tag</DialogTitle>
        <DialogDescription>
          Are you sure you want to delete &ldquo;{tag.name}&rdquo;? This tag will be removed from
          every device that has it.
        </DialogDescription>
      </DialogHeader>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={deleteMutation.isPending}
          className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => deleteMutation.mutate()}
          disabled={deleteMutation.isPending}
          className="min-h-[44px] sm:min-h-0 h-11 sm:h-9"
        >
          {deleteMutation.isPending ? 'Deleting…' : 'Delete tag'}
        </Button>
      </DialogFooter>
    </>
  )
}

export function TagDeleteDialog({ tag, open, onOpenChange }: TagDeleteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="tag-delete-dialog" className="max-h-[90vh] overflow-y-auto">
        {open && tag && <DeleteTagForm tag={tag} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}
