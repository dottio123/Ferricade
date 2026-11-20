import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { cn } from '@/lib/utils'

declare module '@tanstack/history' {
  interface HistoryState {
    fromDeviceId?: string
  }
}

// A device's name, anywhere in the app. It opens the device panel over the
// current page (?device=<id>, handled by the app shell in src/routes/_app.tsx),
// so the page keeps its filters and scroll position; Back or Escape closes it.
export interface DeviceLinkProps extends React.ComponentPropsWithRef<'a'> {
  deviceId: string
  /** Origin device UUID when opening another device from inside the device panel. */
  fromDeviceId?: string
  children: React.ReactNode
  className?: string
  title?: string
}

export function DeviceLink({
  deviceId,
  fromDeviceId,
  children,
  className,
  title,
  onClick,
  ...props
}: DeviceLinkProps) {
  const originId = fromDeviceId && fromDeviceId !== deviceId ? fromDeviceId : undefined

  return (
    <Link
      to="."
      search={(prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, device: deviceId }
        if (originId) next.from = originId
        else delete next.from
        return next
      }}
      {...(originId ? { state: (prev) => ({ ...prev, fromDeviceId: originId }) } : {})}
      data-slot="device-link"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.(e)
      }}
      className={cn(
        'rounded-xs font-medium text-foreground hover:text-primary-text hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    >
      {children}
    </Link>
  )
}
