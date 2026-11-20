import { pageBackgroundColor, textColorFor, toCss } from '@/lib/tagColor'
import { cn } from '@/lib/utils'

export interface TagPillProps {
  name: string
  color: number
  className?: string
}

export function TagPill({ name, color, className }: TagPillProps) {
  const bg = toCss(color)
  const fg = textColorFor(color, pageBackgroundColor())

  return (
    <span
      data-slot="tag-pill"
      title={name}
      style={{ backgroundColor: bg, color: fg }}
      className={cn(
        'inline-flex items-center w-fit self-start px-2 py-0.5 rounded-full text-xs font-medium max-w-full truncate shadow-2xs',
        className,
      )}
    >
      <span className="truncate">{name}</span>
    </span>
  )
}
