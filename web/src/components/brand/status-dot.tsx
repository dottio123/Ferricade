import * as React from 'react'
import { cn } from '@/lib/utils'

export type DeviceStatus = 'online' | 'pending' | 'offline' | 'alert' | 'live'

const statusClasses: Record<DeviceStatus, string> = {
  online: 'bg-status-online text-status-online',
  pending: 'bg-status-pending text-status-pending',
  offline: 'bg-status-offline text-status-offline',
  alert: 'bg-status-alert text-status-alert',
  live: 'bg-status-live text-status-live',
}

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: DeviceStatus
  size?: 'sm' | 'md' | 'lg'
}

export function StatusDot({ status, size = 'md', className, ...props }: StatusDotProps) {
  const [pulsing, setPulsing] = React.useState(false)
  const [prevStatus, setPrevStatus] = React.useState(status)

  if (status !== prevStatus) {
    setPrevStatus(status)
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduced) {
      setPulsing(true)
    }
  }

  React.useEffect(() => {
    if (pulsing) {
      const timer = window.setTimeout(() => setPulsing(false), 1800)
      return () => window.clearTimeout(timer)
    }
  }, [pulsing])

  const sizeClass = size === 'sm' ? 'size-1.5' : size === 'lg' ? 'size-3' : 'size-2'

  return (
    <span
      data-slot="status-dot"
      data-testid="status-dot"
      data-status={status}
      aria-hidden="true"
      className={cn(
        'relative inline-block shrink-0 rounded-full transition-colors duration-200',
        sizeClass,
        statusClasses[status],
        pulsing && 'animate-status-pulse',
        className,
      )}
      {...props}
    />
  )
}
