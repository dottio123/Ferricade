import { cn } from '@/lib/utils'

export interface UserAvatarProps {
  name: string
  src?: string | null
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

function getInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const first = parts[0]
  const last = parts[parts.length - 1]
  if (first && last && parts.length >= 2) {
    return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
  }
  return trimmed.slice(0, 2).toUpperCase()
}

const sizeClasses = {
  sm: 'size-6 text-2xs',
  md: 'size-8 text-xs font-semibold',
  lg: 'size-10 text-sm font-semibold',
}

export function UserAvatar({ name, src, size = 'md', className }: UserAvatarProps) {
  const initials = getInitials(name)

  return (
    <div
      className={cn(
        'rounded-full flex items-center justify-center bg-primary/10 text-primary border border-primary/20 shrink-0 select-none overflow-hidden font-medium',
        sizeClasses[size],
        className,
      )}
    >
      {src ? (
        <img src={src} alt="" className="size-full rounded-full object-cover" />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
    </div>
  )
}
