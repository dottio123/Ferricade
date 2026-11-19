import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { XIcon } from 'lucide-react'
import { Toast as ToastPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

function ToastProvider({ ...props }: React.ComponentProps<typeof ToastPrimitive.Provider>) {
  return <ToastPrimitive.Provider data-slot="toast-provider" swipeDirection="right" {...props} />
}

function ToastViewport({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        'fixed top-0 z-100 flex max-h-screen w-full flex-col-reverse p-4 sm:top-auto sm:right-0 sm:bottom-0 sm:flex-col md:max-w-[420px]',
        className,
      )}
      {...props}
    />
  )
}

const toastVariants = cva(
  'group pointer-events-auto relative flex w-full items-center justify-between space-x-2 overflow-hidden rounded-md border p-4 pr-6 shadow-lg transition-all data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-top-full sm:data-[state=open]:slide-in-from-bottom-full',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-card-foreground',
        destructive:
          'destructive group border-destructive bg-destructive text-destructive-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

function Toast({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Root> & VariantProps<typeof toastVariants>) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  )
}

function ToastAction({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Action>) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      className={cn(
        'inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-border bg-transparent px-3 text-xs font-medium transition-colors hover:bg-secondary focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-destructive-foreground/30 group-[.destructive]:hover:border-destructive-foreground/30 group-[.destructive]:hover:bg-destructive group-[.destructive]:hover:text-destructive-foreground group-[.destructive]:focus:ring-destructive',
        className,
      )}
      {...props}
    />
  )
}

function ToastClose({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      className={cn(
        'absolute top-2 right-2 rounded-md p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 hover:text-foreground focus:opacity-100 focus:outline-hidden focus:ring-2 group-[.destructive]:text-destructive-foreground/70 group-[.destructive]:hover:text-destructive-foreground group-[.destructive]:focus:ring-destructive-foreground cursor-pointer',
        className,
      )}
      toast-close=""
      {...props}
    >
      <XIcon className="size-4" />
    </ToastPrimitive.Close>
  )
}

function ToastTitle({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Title>) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn('text-sm font-semibold [&+div]:text-xs', className)}
      {...props}
    />
  )
}

function ToastDescription({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Description>) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  )
}

// Simple stateful Toast Provider and trigger
export interface ToastData {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  variant?: 'default' | 'destructive'
  action?: React.ReactNode
  open?: boolean
}

type ToastContextType = {
  toast: (data: Omit<ToastData, 'id' | 'open'>) => void
  setKioskSuppressed: (suppressed: boolean) => void
  setDurationSeconds: (seconds: number) => void
}

const ToastContext = React.createContext<ToastContextType | null>(null)

function ManagedToast({
  toast,
  durationSeconds,
  onOpenChange,
}: {
  toast: ToastData
  durationSeconds: number
  onOpenChange: (open: boolean) => void
}) {
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const onOpenChangeRef = React.useRef(onOpenChange)
  const startedAt = React.useRef(0)
  const remaining = React.useRef(durationSeconds * 1000)
  const paused = React.useRef(false)

  React.useLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  const clearTimer = React.useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current))
    }
  }, [])

  const startTimer = React.useCallback(() => {
    if (durationSeconds === 0 || paused.current || timer.current !== null || !toast.open) return
    startedAt.current = Date.now()
    timer.current = setTimeout(() => {
      timer.current = null
      remaining.current = 0
      onOpenChangeRef.current(false)
    }, remaining.current)
  }, [durationSeconds, toast.open])

  React.useEffect(() => {
    remaining.current = durationSeconds * 1000
    if (durationSeconds > 0) startTimer()
    return clearTimer
  }, [clearTimer, durationSeconds, startTimer, toast.open])

  const pause = () => {
    if (paused.current) return
    paused.current = true
    clearTimer()
  }
  const resume = () => {
    if (!paused.current) return
    paused.current = false
    startTimer()
  }

  return (
    <Toast
      variant={toast.variant}
      open={toast.open}
      duration={Infinity}
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocus={pause}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume()
      }}
      onOpenChange={(open) => {
        if (!open) clearTimer()
        onOpenChange(open)
      }}
    >
      <div className="grid gap-1">
        {toast.title && <ToastTitle>{toast.title}</ToastTitle>}
        {toast.description && <ToastDescription>{toast.description}</ToastDescription>}
      </div>
      {toast.action}
      <ToastClose />
    </Toast>
  )
}

export function ToasterProvider({
  children,
  kioskSuppressed = false,
}: {
  children: React.ReactNode
  kioskSuppressed?: boolean
}) {
  const [toasts, setToasts] = React.useState<ToastData[]>([])
  const [contextSuppressed, setContextSuppressed] = React.useState(kioskSuppressed)
  const [durationSeconds, setContextDurationSeconds] = React.useState(5)
  const removalTimers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const isSuppressed = kioskSuppressed || contextSuppressed

  React.useEffect(
    () => () => {
      removalTimers.current.forEach(clearTimeout)
      removalTimers.current.clear()
    },
    [],
  )

  const addToast = React.useCallback(
    (data: Omit<ToastData, 'id' | 'open'>) => {
      if (isSuppressed) return
      const id = Math.random().toString(36).slice(2, 9)
      setToasts((prev) => [...prev, { ...data, id, open: true }])
    },
    [isSuppressed],
  )

  const handleOpenChange = React.useCallback((id: string, open: boolean) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, open } : t)))
    if (!open) {
      const existing = removalTimers.current.get(id)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        removalTimers.current.delete(id)
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, 500)
      removalTimers.current.set(id, timer)
    }
  }, [])

  const contextValue = React.useMemo(
    () => ({
      toast: addToast,
      setKioskSuppressed: setContextSuppressed,
      setDurationSeconds: setContextDurationSeconds,
    }),
    [addToast],
  )

  if (isSuppressed) {
    return (
      <ToastContext.Provider value={contextValue}>
        <ToastProvider>{children}</ToastProvider>
      </ToastContext.Provider>
    )
  }

  return (
    <ToastContext.Provider value={contextValue}>
      <ToastProvider>
        {children}
        {toasts.map((t) => (
          <ManagedToast
            key={t.id}
            toast={t}
            durationSeconds={durationSeconds}
            onOpenChange={(open) => handleOpenChange(t.id, open)}
          />
        ))}
        <ToastViewport />
      </ToastProvider>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = React.useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToasterProvider')
  }
  return context
}

export {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
}
