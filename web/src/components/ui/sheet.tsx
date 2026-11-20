import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive, Portal as PortalPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import {
  OverlayFocusContext,
  OverlayIdProvider,
  useNestedCloseGuard,
  useOverlayFocus,
  useOverlayId,
} from './use-overlay-focus'

function Sheet({ onOpenChange, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const focus = useOverlayFocus()
  const { id, guarded } = useNestedCloseGuard(onOpenChange, focus.closers, props.open !== undefined)
  return (
    <OverlayFocusContext.Provider value={focus}>
      <OverlayIdProvider id={id}>
        <DialogPrimitive.Root data-slot="sheet" {...props} onOpenChange={guarded} />
      </OverlayIdProvider>
    </OverlayFocusContext.Provider>
  )
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-0 pointer-events-auto bg-black/60 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}

const sheetVariants = cva(
  'fixed z-10 pointer-events-auto gap-4 bg-card p-6 text-card-foreground shadow-xl transition ease-in-out data-[state=closed]:duration-200 data-[state=open]:duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out',
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b border-border data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
        bottom:
          'inset-x-0 bottom-0 border-t border-border data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
        left: 'inset-y-0 left-0 h-full w-3/4 border-r border-border data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
        right:
          'inset-y-0 right-0 h-full w-3/4 border-l border-border data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm',
      },
    },
    defaultVariants: {
      side: 'right',
    },
  },
)

interface SheetContentProps
  extends React.ComponentProps<typeof DialogPrimitive.Content>, VariantProps<typeof sheetVariants> {
  showCloseButton?: boolean
  returnFocusSelector?: string
}

function SheetContent({
  side = 'right',
  className,
  children,
  showCloseButton = true,
  returnFocusSelector,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: SheetContentProps) {
  const focus = useOverlayFocus()
  const overlayId = useOverlayId()
  // DialogPortal would remove this unanimated wrapper before its children finish closing.
  return (
    <PortalPrimitive.Root asChild>
      <div data-slot="sheet-portal" className="fixed inset-0 z-50 pointer-events-none">
        <SheetOverlay />
        <DialogPrimitive.Content
          data-slot="sheet-content"
          className={cn(sheetVariants({ side }), className)}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event)
            if (!event.defaultPrevented) focus.restoreFocus(event, returnFocusSelector)
          }}
          {...props}
          data-overlay-content=""
          data-overlay-id={overlayId ?? undefined}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="sheet-close"
              className="absolute top-4 right-4 rounded-xs text-muted-foreground opacity-70 transition-opacity hover:opacity-100 hover:text-foreground focus:ring-2 focus:ring-ring focus:outline-hidden disabled:pointer-events-none cursor-pointer"
            >
              <XIcon className="size-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </div>
    </PortalPrimitive.Root>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-lg font-semibold text-foreground tracking-tight', className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
